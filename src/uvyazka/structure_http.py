"""Loopback adapter, protected by dashboard Host/Origin/token checks on writes."""
import json
from .project_structure import ProjectStructure


def serve_get(handler,workspace,token,path,q):
    if not path.startswith('/api/structure/'):return False
    if path=='/api/structure/config':handler.send({'write_token':token});return True
    service=ProjectStructure(workspace,q['project_id'])
    if path=='/api/structure/catalog':
        handler.send(service.catalog(q.get('kind','sheets'),q.get('q',''),q.get('doc_id'),int(q.get('offset',0)),int(q.get('limit',40))))
    elif path=='/api/structure/table':
        handler.send(service.read(q['table_id'],int(q.get('offset',0)),int(q.get('limit',40)),int(q.get('column_offset',0)),int(q.get('column_limit',20))))
    else:handler.send({'error':'Unknown structure route'},status=404)
    return True


def serve_post(handler,workspace,path,q):
    if path not in {'/api/structure/build','/api/structure/review'}:raise ValueError('Unknown structure action')
    if handler.headers.get('Transfer-Encoding') or handler.headers.get('Content-Type','').split(';')[0]!='application/json':
        raise ValueError('JSON with Content-Length required')
    length=int(handler.headers.get('Content-Length',0))
    if not 2<=length<=32768:raise ValueError('Request exceeds 32 KiB')
    handler.connection.settimeout(60);raw=handler.rfile.read(length)
    if len(raw)!=length:raise ValueError('Incomplete request')
    body=json.loads(raw)
    if not isinstance(body,dict):raise ValueError('JSON object required')
    service=ProjectStructure(workspace,q['project_id'])
    if path.endswith('/build'):
        handler.send(service.build(body.get('doc_id'),body.get('unit_limit',5),body.get('document_limit',3),body.get('retry_failed',False)))
    else:
        allowed={'cell_id','reader','observed_text','state','method','request_id','reason','expected_revision'}
        if set(body)-allowed:raise ValueError('Unknown review field')
        handler.send(service.review(**body))
