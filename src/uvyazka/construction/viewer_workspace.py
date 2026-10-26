"""Versioned presentation state shared by the viewer and MCP, not approved design facts."""
import hashlib
import json
import re
from ..core import connection, encode, now

MAX_BYTES = 4 * 1024 * 1024
SQL = '''create table if not exists viewer_workspaces(
 revision integer primary key, payload text not null, created_at text not null,
 request_id text unique not null, fingerprint text not null)'''


class RevisionConflict(ValueError):
    pass


def validate(state):
    if not isinstance(state, dict) or type(state.get('version')) is not int or state['version'] != 1:
        raise ValueError('Viewer workspace version must be 1')
    required = {'version','model_id','source_sha256','hidden','selection','filters','view','measurements','sets'}
    if not required <= set(state) or set(state) - required - {'specifications'}:
        raise ValueError('Unexpected viewer workspace fields')
    for key in ['model_id','source_sha256']:
        if not isinstance(state[key], str) or not re.fullmatch('[a-f0-9]{64}', state[key]):
            raise ValueError('Exact model/source SHA-256 required')
    def ids(values):
        if not isinstance(values, list) or len(values)>500000 or any(not isinstance(x,str) or not 1<=len(x)<=256 for x in values) or len(set(values))!=len(values):
            raise ValueError('Bounded unique element IDs required')
    ids(state['hidden']); ids(state['selection'])
    filters=state['filters']
    if not isinstance(filters,dict) or set(filters)!={'query','levels','categories','system','parameters','combine','apply3d','grouping'}:
        raise ValueError('Explicit filter fields required')
    for key in ['query','system']:
        if not isinstance(filters[key],str) or len(filters[key])>4096:raise ValueError('Invalid filter text')
    ids(filters['levels']); ids(filters['categories'])
    if filters['combine'] not in {'all','any'} or type(filters['apply3d']) is not bool or filters['grouping'] not in {'categories','levels'}:
        raise ValueError('Invalid filter mode')
    parameters=filters['parameters']
    if not isinstance(parameters,list) or len(parameters)>100:raise ValueError('Too many parameter filters')
    for p in parameters:
        if not isinstance(p,dict) or set(p)!={'name','value','operator'} or not isinstance(p['name'],str) or not isinstance(p['value'],str) or len(p['name'])>1024 or len(p['value'])>4096 or p['operator'] not in {'contains','equals','exists','missing','gt','gte','lt','lte'}:raise ValueError('Invalid parameter filter')
    view=state['view']
    if not isinstance(view,dict) or set(view)!={'position','target','up','planes','xray'} or type(view['xray']) is not bool:raise ValueError('Invalid camera state')
    def vector(v):
        if not isinstance(v,list) or len(v)!=3 or any(type(x) not in (int,float) for x in v):raise ValueError('Finite camera vector required')
    for key in ['position','target','up']:vector(view[key])
    if not any(view['up']):raise ValueError('Camera up cannot be zero')
    if not isinstance(view['planes'],list) or len(view['planes'])>6:raise ValueError('At most six section planes')
    for plane in view['planes']:
        if not isinstance(plane,dict) or set(plane)!={'normal','constant'} or type(plane['constant']) not in (int,float):raise ValueError('Invalid section plane')
        vector(plane['normal'])
        if abs(sum(x*x for x in plane['normal'])-1)>1e-5:raise ValueError('Section normal must be a unit vector')
    if not isinstance(state['measurements'],list) or len(state['measurements'])>10000:raise ValueError('Bounded measurement observations required')
    for row in state['measurements']:
        if not isinstance(row,dict) or row.get('contract')!='SpatialMeasurement' or not isinstance(row.get('model_id'),str) or not isinstance(row.get('points'),list) or len(row['points'])>10000:raise ValueError('Measurement source and points required')
        for point in row['points']:
            if not isinstance(point,dict) or not isinstance(point.get('element_id'),str):raise ValueError('Measurement element required')
            vector(point.get('point_m'))
    if not isinstance(state['sets'],list) or len(state['sets'])>1000:raise ValueError('Bounded selection sets required')
    seen=set()
    for row in state['sets']:
        if not isinstance(row,dict) or not isinstance(row.get('id'),str) or row['id'] in seen or not isinstance(row.get('name'),str) or not 1<=len(row['name'])<=120 or row.get('kind') not in {'explicit','rule'}:raise ValueError('Invalid selection set')
        seen.add(row['id']);ids(row.get('ids'))
        for key in ['model_id','source_sha256']:
            if not re.fullmatch('[a-f0-9]{64}',str(row.get(key,''))):raise ValueError('Selection set source required')
        if row['kind']=='rule':
            # Reuse the same validation without nested sets or observations.
            validate({**state,'sets':[],'measurements':[],'filters':row.get('filters')})
    specifications = state.get('specifications', [])
    if not isinstance(specifications, list) or len(specifications)>30:
        raise ValueError('At most 30 specification definitions')
    for spec in specifications:
        fields = {'version','name','model_id','source_hashes','columns','group_by','filters','sort','scope'}
        if not isinstance(spec,dict) or not fields <= set(spec) or set(spec)-fields-{'scope_ids'} or type(spec['version']) is not int or spec['version']!=1:
            raise ValueError('Invalid specification definition')
        if not isinstance(spec['name'],str) or not 1<=len(spec['name'].strip())<=120:
            raise ValueError('Bounded specification name required')
        if spec['model_id'] is not None and (not isinstance(spec['model_id'],str) or not re.fullmatch('[a-f0-9]{64}',spec['model_id'])):
            raise ValueError('Specification model SHA-256 required')
        if not isinstance(spec['source_hashes'],list) or len(spec['source_hashes'])>1000 or any(not isinstance(h,str) or not re.fullmatch('[a-f0-9]{64}',h) for h in spec['source_hashes']):
            raise ValueError('Specification source SHA-256 required')
        columns=spec['columns']
        if not isinstance(columns,list) or not 1<=len(columns)<=40:
            raise ValueError('Specification needs 1-40 columns')
        seen=set()
        for column in columns:
            if not isinstance(column,dict) or set(column)!={'id','label','aggregate'} or not isinstance(column['id'],str) or not 1<=len(column['id'])<=2048 or column['id'] in seen or not isinstance(column['label'],str) or len(column['label'])>256 or not isinstance(column['aggregate'],str) or column['aggregate'] not in {'none','sum','min','max'}:
                raise ValueError('Invalid specification column')
            seen.add(column['id'])
        if not isinstance(spec['group_by'],list) or any(not isinstance(i,str) or i not in seen for i in spec['group_by']) or not isinstance(spec['scope'],str) or spec['scope'] not in {'all','matches','selection'}:
            raise ValueError('Invalid specification grouping or scope')
        if 'scope_ids' in spec:ids(spec['scope_ids'])
        sort=spec['sort']
        if sort is not None and (not isinstance(sort,dict) or set(sort)!={'id','direction'} or not isinstance(sort['id'],str) or sort['id'] not in seen or type(sort['direction']) is not int or sort['direction'] not in {-1,1}):
            raise ValueError('Invalid specification sort')
        if not isinstance(spec['filters'],list) or len(spec['filters'])>100:
            raise ValueError('Too many specification conditions')
        for f in spec['filters']:
            if not isinstance(f,dict) or not {'field_id','operator'} <= set(f) or set(f)-{'field_id','operator','value','unit'} or not isinstance(f['field_id'],str) or len(f['field_id'])>2048 or not isinstance(f['operator'],str) or f['operator'] not in {'equal','not_equal','greater','greater_equal','less','less_equal','contains','not_contains','begins','ends','has_value'}:
                raise ValueError('Invalid specification condition')
            if 'value' in f and type(f['value']) not in (str,int,float):raise ValueError('Scalar specification threshold required')
            if 'value' in f and isinstance(f['value'],str) and len(f['value'])>4096:raise ValueError('Specification threshold too long')
            if 'unit' in f and (not isinstance(f['unit'],str) or len(f['unit'])>120):raise ValueError('Invalid specification unit')
    payload=encode(state)  # rejects NaN/Infinity, including nested observations
    if len(payload.encode('utf8'))>MAX_BYTES:raise ValueError('Viewer workspace exceeds 4 MiB')
    return payload


class ViewerWorkspace:
    def __init__(self,workspace):self.workspace=workspace

    def get(self,project_id,revision=None):
        if revision is not None and (type(revision) is not int or revision<1):raise ValueError('Positive workspace revision required')
        with connection(self.workspace.db_path(project_id)) as db:
            db.execute(SQL)
            row=db.execute('select * from viewer_workspaces order by revision desc limit 1').fetchone() if revision is None else db.execute('select * from viewer_workspaces where revision=?',(revision,)).fetchone()
            if row is None:
                if revision is not None:raise ValueError('Workspace revision not found')
                return {'revision':0,'state':None,'storage':'project_database','schema':'docs/VIEWER_WORKSPACE.md','approval_status':'presentation_and_unreviewed_observations','source_verification':'declared_package_not_reopened'}
            return {'revision':row['revision'],'created_at':row['created_at'],'state':json.loads(row['payload']),'storage':'project_database','approval_status':'presentation_and_unreviewed_observations','source_verification':'declared_package_not_reopened'}

    def save(self,project_id,state,expected_revision,request_id):
        payload=validate(state)
        if type(expected_revision) is not int or expected_revision<0:raise ValueError('Nonnegative expected_revision required')
        if not isinstance(request_id,str) or not 1<=len(request_id)<=128:raise ValueError('request_id: 1–128 characters')
        fingerprint=hashlib.sha256(encode([state,expected_revision]).encode()).hexdigest()
        with connection(self.workspace.db_path(project_id)) as db:
            db.execute(SQL);db.execute('begin immediate')
            old=db.execute('select revision,fingerprint from viewer_workspaces where request_id=?',(request_id,)).fetchone()
            if old:
                if old['fingerprint']!=fingerprint:raise ValueError('request_id reused with different content')
                return {'revision':old['revision'],'storage':'project_database'}
            current=db.execute('select coalesce(max(revision),0) from viewer_workspaces').fetchone()[0]
            if expected_revision!=current:raise RevisionConflict(f'Workspace changed: expected {expected_revision}, current {current}. Read before saving.')
            revision=current+1
            db.execute('insert into viewer_workspaces values(?,?,?,?,?)',(revision,payload,now(),request_id,fingerprint))
            return {'revision':revision,'storage':'project_database'}
