"""Register checksum-verified viewer packages as unapproved derived models."""
import hashlib
import json
import math
import re
import struct
from uuid import uuid4
from ..core import connection, encode
from .coordination_store import CoordinationStore
from .planning import Planning


def validate_package(model, binary):
    if not isinstance(model, dict) or model.get('contract') != 'ModelPackage' or model.get('contract_version') != '0.1.0':
        raise ValueError('ModelPackage 0.1.0 required')
    if len(binary) > 512 * 1024**2 or model.get('statistics', {}).get('binary_bytes') != len(binary):
        raise ValueError('Geometry size mismatch or budget exceeded')
    for value in [model.get('model_id'), model.get('source', {}).get('sha256')]:
        if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):raise ValueError('Explicit model/source SHA256 required')
    coords = model.get('coordinate_system', {})
    if coords.get('up_axis') != 'Z':raise ValueError('Metre-normalized Z-up scene required')
    for key in ['render_origin_m','bounds_min_m','bounds_max_m']:
        v = coords.get(key)
        if not isinstance(v,list) or len(v)!=3 or any(type(x) not in (int,float) or not math.isfinite(x) for x in v):raise ValueError('Finite scene coordinates required')
    elements = model.get('elements')
    if not isinstance(elements,list) or len(elements)>2_000_000:raise ValueError('Bounded elements required')
    ids=set()
    for element in elements:
        key=element.get('id') if isinstance(element,dict) else None
        if not isinstance(key,str) or not 1<=len(key)<=512 or key in ids:raise ValueError('Unique element IDs required')
        ids.add(key);mesh=element.get('mesh')
        if not mesh:continue
        vc,ic,po,io=[mesh.get(k) for k in ['vertex_count','index_count','position_byte_offset','index_byte_offset']]
        if any(type(x) is not int or x<0 for x in [vc,ic,po,io]) or po%4 or io%4 or po+vc*12>len(binary) or io+ic*4>len(binary):raise ValueError('Invalid mesh ranges')
        if any(not math.isfinite(x[0]) for x in struct.iter_unpack('<f',memoryview(binary)[po:po+vc*12])):raise ValueError('Nonfinite mesh position')
        if any(x[0]>=vc for x in struct.iter_unpack('<I',memoryview(binary)[io:io+ic*4])):raise ValueError('Invalid mesh index')


def register_viewer_model(workspace, project, scene_id, request_id):
    if not isinstance(request_id,str) or not 1<=len(request_id)<=128:raise ValueError('Request ID required')
    model,binary=CoordinationStore(workspace).scene(project,scene_id)
    validate_package(model,binary)
    model={key:value for key,value in model.items() if key not in {'project_id','registration'}}
    fingerprint=hashlib.sha256(encode(['register-viewer-model',model,hashlib.sha256(binary).hexdigest()]).encode()).hexdigest()
    planning=Planning(workspace);db_path=planning._db(project)
    payload={**model,'project_id':project,'registration':{'origin':'viewer_derived_package','original_file_reopened':False,'approval_status':'unreviewed','fingerprint':fingerprint}}
    folder=db_path.parent/'construction/models'/model['model_id']
    with connection(db_path) as db:
        db.execute('begin immediate')
        old=db.execute('select * from construction_requests where request_id=?',(request_id,)).fetchone()
        if old:
            if old['fingerprint']!=fingerprint:raise ValueError('request_id reused with different package')
            return json.loads(old['result'])
        previous=db.execute('select payload from construction_models where model_id=?',(model['model_id'],)).fetchone()
        if previous:
            existing=json.loads(previous['payload'])
            if {key:value for key,value in existing.items() if key not in {'project_id','registration'}}!=model:raise ValueError('Model ID already has another package; existing model preserved')
            if not (folder/'geometry.bin').is_file() or hashlib.sha256((folder/'geometry.bin').read_bytes()).digest()!=hashlib.sha256(binary).digest():raise ValueError('Registered geometry changed')
        else:
            folder.parent.mkdir(parents=True,exist_ok=True)
            if folder.exists():
                if not (folder/'geometry.bin').is_file() or (folder/'geometry.bin').read_bytes()!=binary or not (folder/'model.json').is_file() or json.loads((folder/'model.json').read_text(encoding='utf-8'))!=payload:raise ValueError('Model cache conflicts with package')
            else:
                stage=folder.parent/('.incoming-'+uuid4().hex);stage.mkdir()
                (stage/'geometry.bin').write_bytes(binary);(stage/'model.json').write_text(encode(payload),encoding='utf-8');stage.rename(folder)
            db.execute('insert into construction_models values(?,?)',(model['model_id'],encode(payload)))
        result={'project_id':project,'model_id':model['model_id'],'scene_id':scene_id,'source_sha256':model['source']['sha256'],'approval_status':'unreviewed','original_file_reopened':False,'storage':'project_database'}
        db.execute('insert into construction_requests values(?,?,?)',(request_id,fingerprint,encode(result)))
    return result
