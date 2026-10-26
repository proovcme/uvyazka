"""Loopback same-origin presentation-state adapter; dashboard protects all writes."""
import json
from .viewer_workspace import ViewerWorkspace,RevisionConflict,MAX_BYTES


def serve_get(handler,workspace,token,path,query):
    if not path.startswith('/api/viewer/'):return False
    if path=='/api/viewer/config':handler.send({'token':token,'storage':'project_database','max_bytes':MAX_BYTES})
    elif path=='/api/viewer/workspace':handler.send(ViewerWorkspace(workspace).get(query['project_id']))
    else:handler.send({'error':'Unknown viewer route'},status=404)
    return True


def serve_post(handler,workspace,query):
    if handler.headers.get('Transfer-Encoding') or handler.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('JSON with Content-Length required')
    length=int(handler.headers.get('Content-Length',0))
    if not 2<=length<=MAX_BYTES:raise ValueError('Workspace request exceeds budget')
    handler.connection.settimeout(30)
    raw=handler.rfile.read(length)
    if len(raw)!=length:raise ValueError('Incomplete request')
    body=json.loads(raw,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Nonfinite JSON value')))
    if not isinstance(body,dict):raise ValueError('JSON object required')
    try:handler.send(ViewerWorkspace(workspace).save(query['project_id'],body['state'],body['expected_revision'],body['request_id']))
    except RevisionConflict as error:handler.send({'error':str(error)},status=409)
