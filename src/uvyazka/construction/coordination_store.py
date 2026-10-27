"""Versioned coordination objects and immutable derived scenes in the project DB."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from uuid import uuid4

from ..core import connection, encode, now, digest
from .viewer_workspace import validate as validate_view, RevisionConflict
from .clashes import validate_rule, hashed

KINDS={'view','view_template','clash_template','clash_run','issue'}
SQL=[
    'create table if not exists coordination_objects(kind text not null,object_id text not null,revision integer not null,payload text not null,created_at text not null,primary key(kind,object_id,revision))',
    'create table if not exists coordination_requests(request_id text primary key,fingerprint text not null,result text not null)',
    'create table if not exists coordination_scenes(scene_id text primary key,model text not null,binary_sha256 text not null,size integer not null,received integer not null,ready integer not null)',
    'create table if not exists clash_jobs(job_id text primary key,scene_id text not null,rule text not null,status text not null,report text,owner text,heartbeat text not null,cancel integer not null default 0,error text)',
]


class CoordinationStore:
    def __init__(self, workspace):self.workspace=workspace

    def db(self, project):
        # These additive tables do not change existing project/workspace contracts.
        path=self.workspace.db_path(project)
        with connection(path) as db:
            for statement in SQL:db.execute(statement)
        return connection(path)

    def get(self, project, kind, object_id, revision=None):
        if kind not in KINDS:raise ValueError('Unknown coordination object kind')
        with self.db(project) as db:
            row=db.execute('select * from coordination_objects where kind=? and object_id=? '+('and revision=? ' if revision is not None else '')+'order by revision desc limit 1', (kind,object_id,revision) if revision is not None else (kind,object_id)).fetchone()
        if not row:raise ValueError('Coordination object not found')
        return {'kind':kind,'id':object_id,'revision':row['revision'],'created_at':row['created_at'],'payload':json.loads(row['payload'])}

    def list(self, project, kind, offset=0, limit=100):
        if kind not in KINDS or type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=200:raise ValueError('Invalid kind/page')
        with self.db(project) as db:
            rows=db.execute('select o.* from coordination_objects o join (select object_id,max(revision) revision from coordination_objects where kind=? group by object_id) n on o.object_id=n.object_id and o.revision=n.revision where o.kind=? order by o.created_at desc',(kind,kind)).fetchall()
        items=[{'kind':kind,'id':r['object_id'],'revision':r['revision'],'created_at':r['created_at'],'payload':json.loads(r['payload'])} for r in rows[offset:offset+limit]]
        if kind=='clash_run':
            for item in items:
                p=item['payload'];item['payload']={k:p.get(k) for k in ('model_id','source_sha256','created_at','status','complete','rule','scene_id')};item['payload']['issue_count']=len(p.get('issues',[]))
        return {'items':items,'total':len(rows),'next_offset':offset+limit if offset+limit<len(rows) else None}

    def save(self, project, kind, object_id, payload, expected_revision, request_id):
        if kind not in KINDS or not isinstance(object_id,str) or not 1<=len(object_id)<=160:raise ValueError('Object kind/id required')
        if type(expected_revision) is not int or expected_revision<0 or not isinstance(request_id,str) or not 1<=len(request_id)<=128:raise ValueError('Expected revision and request ID required')
        if not isinstance(payload,dict) or len(encode(payload).encode())>32*1024*1024:raise ValueError('Bounded object required')
        if kind=='view':validate_view(payload['state'])
        elif kind=='view_template':
            if set(payload)!={'name','basis_model_id','filters','xray'} or type(payload['xray']) is not bool or not isinstance(payload['filters'],dict):raise ValueError('View template contract required')
            # Validate with a minimal synthetic presentation envelope; no camera in template.
            validate_view({'version':1,'model_id':payload['basis_model_id'],'source_sha256':'0'*64,'hidden':[],'selection':[],
                'filters':payload['filters'],'view':{'position':[1,1,1],'target':[0,0,0],'up':[0,1,0],'planes':[],'xray':payload['xray']},'measurements':[],'sets':[]})
        elif kind=='clash_template':validate_rule(payload)
        elif kind=='clash_run':
            if payload.get('version')!=1 or not isinstance(payload.get('coverage'),dict) or not isinstance(payload.get('issues'),list) or not re.fullmatch('[a-f0-9]{64}',payload.get('geometry_sha256','')):raise ValueError('Collision report contract required')
            payload={**payload,'verification':'submitted_or_engine_generated_observations_not_accepted_facts'}
        elif kind=='issue':
            if payload.get('status') not in {'new','review','confirmed','accepted','resolved','reopened','question','stale'}:raise ValueError('Issue status required')
            if not isinstance(payload.get('reason'),str) or not payload['reason'].strip() or not isinstance(payload.get('actor'),str) or not payload['actor'].strip():raise ValueError('Issue decision needs reason and actor')
            if 'view' in payload and payload['view'] is not None:validate_view(payload['view'])
        fingerprint=hashed([kind,object_id,payload,expected_revision])
        with self.db(project) as db:
            db.execute('begin immediate')
            old=db.execute('select * from coordination_requests where request_id=?',(request_id,)).fetchone()
            if old:
                if old['fingerprint']!=fingerprint:raise ValueError('request_id reused with different content')
                return json.loads(old['result'])
            current=db.execute('select coalesce(max(revision),0) from coordination_objects where kind=? and object_id=?',(kind,object_id)).fetchone()[0]
            if current!=expected_revision:raise RevisionConflict('Object changed; read it before saving')
            result={'kind':kind,'id':object_id,'revision':current+1,'storage':'project_database'}
            db.execute('insert into coordination_objects values(?,?,?,?,?)',(kind,object_id,current+1,encode(payload),now()))
            db.execute('insert into coordination_requests values(?,?,?)',(request_id,fingerprint,encode(result)))
        return result

    def scene_folder(self, project, scene_id):
        if not re.fullmatch('[a-f0-9]{64}',scene_id or ''):raise ValueError('Invalid scene ID')
        return self.workspace.db_path(project).parent/'coordination/scenes'/scene_id

    def begin_scene(self, project, model, binary_sha256):
        if not isinstance(model,dict) or model.get('contract')!='ModelPackage' or len(encode(model).encode())>64*1024*1024:raise ValueError('Bounded ModelPackage required')
        size=model.get('statistics',{}).get('binary_bytes')
        if type(size) is not int or not 0<size<=2*1024**3 or not re.fullmatch('[a-f0-9]{64}',binary_sha256 or ''):raise ValueError('Geometry size/hash required')
        scene_id=hashed([model,binary_sha256]);folder=self.scene_folder(project,scene_id);folder.mkdir(parents=True,exist_ok=True)
        with self.db(project) as db:
            db.execute('insert or ignore into coordination_scenes values(?,?,?,?,0,0)',(scene_id,encode(model),binary_sha256,size))
            row=db.execute('select received,ready from coordination_scenes where scene_id=?',(scene_id,)).fetchone()
        return {'scene_id':scene_id,'received':row['received'],'ready':bool(row['ready']),'chunk_bytes':4*1024**2,'source_verification':'derived_package_submitted_by_viewer; original_file_not_reopened'}

    def scene_chunk(self, project, scene_id, offset, raw):
        if type(offset) is not int or offset<0 or not 0<len(raw)<=4*1024**2:raise ValueError('Invalid geometry chunk')
        folder=self.scene_folder(project,scene_id);target=folder/'geometry.bin'
        with self.db(project) as db:
            db.execute('begin immediate');row=db.execute('select * from coordination_scenes where scene_id=?',(scene_id,)).fetchone()
            if not row or offset+len(raw)>row['size']:raise ValueError('Unknown scene or oversized chunk')
            if offset<row['received']:
                with target.open('rb') as f:f.seek(offset);existing=f.read(len(raw))
                if offset+len(raw)>row['received'] or existing!=raw:raise ValueError('Chunk retry differs')
                return {'received':row['received'],'ready':bool(row['ready'])}
            if offset!=row['received']:raise ValueError('Resume from the confirmed byte offset')
            with target.open('r+b' if target.exists() else 'w+b') as f:
                f.seek(offset);f.truncate();f.write(raw);f.flush()
            received=offset+len(raw);ready=received==row['size']
            if ready and digest(target)!=row['binary_sha256']:raise ValueError('Geometry checksum mismatch; restart upload')
            db.execute('update coordination_scenes set received=?,ready=? where scene_id=?',(received,int(ready),scene_id))
        return {'received':received,'ready':ready}

    def scene(self, project, scene_id):
        self.scene_folder(project,scene_id)
        with self.db(project) as db:row=db.execute('select * from coordination_scenes where scene_id=?',(scene_id,)).fetchone()
        if row:
            if not row['ready']:raise ValueError('Scene geometry upload is incomplete')
            path=self.scene_folder(project,scene_id)/'geometry.bin'
            if digest(path)!=row['binary_sha256']:raise ValueError('Cached scene geometry changed')
            return json.loads(row['model']),path.read_bytes()
        from .planning import Planning
        p=Planning(self.workspace)
        return p.model(project,scene_id),(p.model_path(project,scene_id)/'geometry.bin').read_bytes()
