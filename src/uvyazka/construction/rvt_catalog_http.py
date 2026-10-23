"""Same-origin loopback adapter; caller enforces Host/Origin/session-token on writes."""
import json
from .rvt_catalog import RvtCatalog, MAX_BYTES


def serve_get(handler, workspace, token, path, query):
    if not path.startswith('/api/rvt/catalog'):
        return False
    if path == '/api/rvt/catalog/config':
        handler.send({'write_token': token, 'storage': 'project_database', 'max_catalogue_bytes': MAX_BYTES})
    elif path == '/api/rvt/catalog':
        service = RvtCatalog(workspace); project = query['project_id']
        if query.get('model_id'):
            from .planning import Planning
            model=Planning(workspace).model(project,query['model_id'])
            source=model['source']
            document=service.for_source(project,source['sha256'])
            handler.send({'document':document,'source':{'sha256':source['sha256'],'format':source.get('format','ifc')}})
        else:
            document = service.document(project, query['extraction_id']) if query.get('extraction_id') else service.for_source(project, query['source_sha256'])
            handler.send({'document': document})
    elif path == '/api/rvt/catalog/list':
        handler.send(RvtCatalog(workspace).list(query['project_id'], query.get('source_sha256', ''), int(query.get('offset', 0)), int(query.get('limit', 40))))
    else:
        handler.send({'error': 'Unknown RVT catalogue route'}, status=404)
    return True


def serve_post(handler, workspace, query):
    if handler.headers.get('Transfer-Encoding') or handler.headers.get('Content-Type', '').split(';')[0] != 'application/json':
        raise ValueError('JSON with Content-Length required')
    length = int(handler.headers.get('Content-Length', 0))
    if not 2 <= length <= MAX_BYTES:
        raise ValueError('Catalogue exceeds request budget')
    handler.connection.settimeout(120)
    raw = handler.rfile.read(length)
    if len(raw) != length:
        raise ValueError('Incomplete catalogue request')
    body = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON value')))
    if not isinstance(body, dict):
        raise ValueError('JSON object required')
    result = RvtCatalog(workspace).save(query['project_id'], body['document'], body['request_id'])
    handler.send(result)
