"""Loopback retrieval routes; configuration/executable selection remains local CLI only."""
import json
from .semantic_search import SemanticSearch


def serve_get(handler,workspace,path,q):
    if path not in {'/api/semantic/status','/api/semantic/search'}:return False
    service=SemanticSearch(workspace,q['project_id'])
    if path.endswith('/status'):result=service.status()
    else:result=service.search(q.get('q',''),q.get('mode','hybrid'),int(q.get('limit',10)),q.get('doc_id'),float(q.get('min_similarity',0.72)))
    handler.send(result);return True


def serve_post(handler,workspace,q):
    if handler.headers.get('Content-Type','').split(';')[0]!='application/json' or handler.headers.get('Transfer-Encoding'):
        raise ValueError('JSON with Content-Length required')
    length=int(handler.headers.get('Content-Length',0))
    if not 2<=length<=16*1024:raise ValueError('Embedding request exceeds 16 KiB')
    handler.connection.settimeout(60);raw=handler.rfile.read(length)
    if len(raw)!=length:raise ValueError('Incomplete request')
    def reject(value):raise ValueError('Nonfinite JSON value: '+value)
    body=json.loads(raw,parse_constant=reject)
    if not isinstance(body,dict) or set(body)-{'limit','doc_ids','retry_failed'}:raise ValueError('Unknown embedding request fields')
    handler.send(SemanticSearch(workspace,q['project_id']).build(**body))
