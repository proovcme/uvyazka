"""One agent operation: cached native data + validated geometry, without Revit."""
from __future__ import annotations
import json
import os
import subprocess
from uuid import uuid4

from ..core import connection,digest,encode,now
from .authoring_tools import import_rvt_document
from .planning import Planning
from .rvt_data import RvtData
from .simulation import canonical_hash


def prepare(workspace,project_id,doc_id,request_id,convert_geometry=True,progress=None):
    if not request_id or len(request_id)>128:raise ValueError('request_id: 1–128 characters')
    document,source=workspace.source_record(project_id,doc_id)
    if source.suffix.lower()!='.rvt' or not 0<source.stat().st_size<=512*1024*1024:raise ValueError('Choose a registered RVT <=512 MiB')
    with source.open('rb') as stream:
        if stream.read(8)!=bytes.fromhex('D0CF11E0A1B11AE1'):raise ValueError('RVT OLE/CFB signature missing')
    pointer={'doc_id':doc_id,'sha256':document['sha256'] or digest(source),'locator':'Native RVT preparation'}
    planning=Planning(workspace);planning.validate_sources(project_id,[pointer])
    data=RvtData(workspace);path=data.db(project_id)
    fingerprint=canonical_hash(['rvt-preparation-v1',doc_id,pointer['sha256'],convert_geometry])
    with connection(path) as db:
        db.execute('create table if not exists rvt_preparations(request_id text primary key,fingerprint text not null,payload text)')
        db.execute('insert or ignore into rvt_preparations values (?,?,null)',(request_id,fingerprint))
        cached=db.execute('select fingerprint,payload from rvt_preparations where request_id=?',(request_id,)).fetchone()
    if cached:
        if cached['fingerprint']!=fingerprint:raise ValueError('request_id already used for different RVT preparation inputs')
        if cached['payload'] is not None:return json.loads(cached['payload'])
    # Independent stages: failure of one does not erase the other. A logical
    # request is immutable; use a new request_id after fixing a failed stage.
    stage_id=lambda name:canonical_hash(['prepare-rvt',request_id,name])
    native=None;geometry=None;stages={}
    caught=(ValueError,OSError,subprocess.SubprocessError)
    try:
        if progress:progress('extracting')
        native=data.extract(project_id,doc_id,stage_id('data'),'all')
        stages['data']={'status':native['status'],'extraction_id':native['extraction_id'],
            'record_count':native['record_count'],'counts':native['counts']}
    except caught as error:
        stages['data']={'status':'failed','error':str(error)[-2500:]}
    planning.validate_sources(project_id,[pointer])
    if convert_geometry:
        try:
            if progress:progress('converting')
            imported=import_rvt_document(workspace,project_id,doc_id,stage_id('geometry'))
            geometry=planning.model(project_id,imported['model_id'])
            conversion=geometry['source']['conversion']
            stages['geometry']={'status':'converted_requires_review','model_id':geometry['model_id'],
                'element_count':len(geometry['elements']),'ifc_validation_errors':conversion.get('ifc_validation_errors'),
                'diagnostic_counts':{k:len(conversion.get(k,[])) for k in ['warnings','skipped','unsupported_features']},
                'phase_status':geometry.get('revit',{}).get('status','unavailable')}
        except caught as error:
            stages['geometry']={'status':'failed','error':str(error)[-2500:]}
    else:stages['geometry']={'status':'not_requested'}
    planning.validate_sources(project_id,[pointer])
    crosswalk=None
    if progress:progress('linking')
    if native is not None and geometry is not None:
        with connection(path,readonly=True) as db:
            ids={r['element_id']:r['record_id'] for r in db.execute('select element_id,record_id from rvt_native_records where extraction_id=?',(native['extraction_id'],))}
        links=[]
        for row in geometry['elements']:
            element_id=str(row.get('revit',{}).get('element_id') or '')
            links.append({'geometry_element_id':row['id'],'revit_element_id':element_id or None,
                'native_record_id':ids.get(element_id),'status':'matched_exact_element_id' if element_id in ids else 'native_record_not_found'})
        matched={row['revit_element_id'] for row in links if row['native_record_id'] is not None}
        folder=path.parent/'rvt-preparations'/fingerprint;folder.mkdir(parents=True,exist_ok=True)
        artifact=folder/(canonical_hash([request_id,native['extraction_id'],geometry['model_id']])+'.crosswalk.json')
        temporary=folder/(uuid4().hex+'.tmp')
        temporary.write_text(encode({'schema_version':1,'project_id':project_id,'source':pointer,
            'extraction_id':native['extraction_id'],'model_id':geometry['model_id'],'links':links}),encoding='utf-8')
        os.replace(temporary,artifact)
        crosswalk={'artifact':str(artifact),'sha256':digest(artifact),'geometry_rows':len(links),
            'matched_geometry_rows':sum(row['native_record_id'] is not None for row in links),
            'native_records_not_in_geometry':len(set(ids)-matched),
            'interpretation':'Native records also include views, types and settings; absence from geometry is not automatically an error'}
    successful=native is not None or geometry is not None
    complete=native is not None and native['status']=='extracted_requires_review' and (geometry is not None or not convert_geometry)
    status=('prepared_requires_review' if convert_geometry else 'data_only_requires_review') if complete else 'partial' if successful else 'failed'
    result={'project_id':project_id,'request_id':request_id,'source':pointer,'created_at':now(),
        'status':status,'requires_revit':False,'stages':stages,'crosswalk':crosswalk,
        'next_tools':{'data':['get_rvt_data','get_rvt_record','export_rvt_record'] if native else [],
            'geometry':['get_rvt_conversion','get_spatial_elements','suggest_ifc_scenario'] if geometry else []},
        'limitations':['Saved schedule cells are not an evaluated schedule body','View settings are not regenerated drawings',
            'Conversion and quantities require coverage review; no engineering acceptance implied'],
        'retry':'Same request_id returns this report. After fixing a failed stage, use a new request_id; successful stage caches are reused.'}
    with connection(path) as db:
        db.execute('begin immediate')
        previous=db.execute('select fingerprint,payload from rvt_preparations where request_id=?',(request_id,)).fetchone()
        if previous:
            if previous['fingerprint']!=fingerprint:raise ValueError('Concurrent RVT preparation has different inputs')
            if previous['payload'] is not None:return json.loads(previous['payload'])
        db.execute('update rvt_preparations set payload=? where request_id=?',(encode(result),request_id))
        db.execute('insert into events(created_at,kind,payload) values (?,?,?)',(now(),'rvt_prepared',encode(result)))
    return result
