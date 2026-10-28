"""Protected loopback GUI adapter. Same services as clash_tools, not a second DB."""
import json
from .coordination_store import CoordinationStore
from .clash_jobs import ClashJobs,compare_runs
from .clash_tools import report_with_decisions
from .clash_export import bcf,xlsx
from .viewer_workspace import RevisionConflict


def serve_get(handler,workspace,token,path,q):
    if not path.startswith('/api/review3d/'):return False
    store=CoordinationStore(workspace);project=q.get('project_id','');key=path.rsplit('/',1)[-1]
    if key=='config':handler.send({'token':token,'storage':'project_database','version':1});return True
    if key=='objects':handler.send(store.list(project,q['kind'],int(q.get('offset','0')),int(q.get('limit','100'))))
    elif key=='object':handler.send(store.get(project,q['kind'],q['id'],int(q['revision']) if q.get('revision') else None))
    elif key=='jobs':handler.send(ClashJobs(workspace).list(project))
    elif key=='job':handler.send(ClashJobs(workspace).get(project,q['id']))
    elif key=='export':
        report,views=report_with_decisions(store,project,q['run_id']);fmt=q.get('format','bcf')
        if fmt=='bcf':handler.send(bcf(report,views,q.get('version','3.0')),'application/octet-stream')
        elif fmt=='xlsx':handler.send(xlsx(report),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        elif fmt=='json':handler.send(report)
        else:raise ValueError('Unknown export format')
    else:handler.send({'error':'Unknown coordination route'},status=404)
    return True


def serve_post(handler,workspace,path,project,q):
    if handler.headers.get('Transfer-Encoding'):raise ValueError('Content-Length required')
    length=int(handler.headers.get('Content-Length','0'))
    if path.endswith('/scene-chunk'):
        if handler.headers.get('Content-Type')!='application/octet-stream' or not 0<length<=4*1024**2:raise ValueError('Bounded binary chunk required')
        raw=handler.rfile.read(length)
        if len(raw)!=length:raise ValueError('Incomplete chunk')
        return handler.send(CoordinationStore(workspace).scene_chunk(project,q['scene_id'],int(q['offset']),raw))
    if handler.headers.get('Content-Type','').split(';')[0]!='application/json' or not 2<=length<=64*1024**2:raise ValueError('Bounded JSON required')
    raw=handler.rfile.read(length)
    if len(raw)!=length:raise ValueError('Incomplete request')
    body=json.loads(raw,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Finite JSON required')))
    store=CoordinationStore(workspace);key=path.rsplit('/',1)[-1]
    try:
        if key=='save':handler.send(store.save(project,body['kind'],body['id'],body['payload'],body['expected_revision'],body['request_id']))
        elif key=='scene-start':handler.send(store.begin_scene(project,body['model'],body['binary_sha256']))
        elif key=='register-model':
            from .viewer_models import register_viewer_model
            handler.send(register_viewer_model(workspace,project,body['scene_id'],body['request_id']))
        elif key=='run':handler.send(ClashJobs(workspace).start(project,body['scene_id'],body['rule'],body['request_id']))
        elif key=='cancel':handler.send(ClashJobs(workspace).cancel(project,body['job_id']))
        elif key=='compare':handler.send(compare_runs(store.get(project,'clash_run',body['before_id'])['payload'],store.get(project,'clash_run',body['after_id'])['payload'],body.get('lineage_confirmed',False)))
        else:handler.send({'error':'Unknown review write route'},status=404)
    except RevisionConflict as ex:handler.send({'error':str(ex)},status=409)
