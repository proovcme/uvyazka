"""Loopback API to the same snapshots as MCP. No arbitrary file-path endpoint."""
import json
from .model_data import ModelData
from .model_readers import reader_status


def serve_get(handler, workspace, token, path, q):
    if not path.startswith('/api/models/'):
        return False
    if path == '/api/models/status':
        handler.send({**reader_status(workspace), 'write_token': token})
        return True
    if path == '/api/models/original':
        from .model_source_http import serve_original
        serve_original(handler, workspace, q)
        return True
    service = ModelData(workspace)
    project = q.get('project_id', '')
    if path == '/api/models/documents':
        result = service.documents(project, q.get('q', ''), int(q.get('offset', 0)))
    elif path == '/api/models/datasets':
        result = service.list(project, int(q.get('offset', 0)), int(q.get('limit', 20)))
    elif path == '/api/models/query':
        result = service.query(project, q['dataset_id'], q.get('section', 'elements'), q.get('q', ''), q.get('native_id'),
            json.loads(q.get('filters', '[]')), q.get('cursor'), int(q.get('limit', 40)), q.get('search_properties') == '1',
            json.loads(q['columns']) if 'columns' in q else None)
    elif path == '/api/models/object':
        result = service.object(project, q['dataset_id'], q['object_id'], json.loads(q.get('json_path', '[]')),
            int(q.get('offset', 0)), int(q.get('max_chars', 6000)), q.get('verify_source') == '1')
    elif path == '/api/models/table/export':
        from .construction.model_tables import ModelTables
        fmt = q.get('format', 'csv')
        stored = ModelTables(workspace).stored(project, q['table_id'])
        if stored['kind'] != 'snapshot' or fmt not in {'csv', 'json'}:
            raise ValueError('Choose a snapshot table and CSV or JSON')
        handler.send(ModelTables.render(stored, fmt), 'text/csv; charset=utf-8' if fmt == 'csv' else 'application/json; charset=utf-8')
        return True
    else:
        return False
    handler.send(result)
    return True


def serve_post(handler, workspace, q, path='/api/models/read'):
    if handler.headers.get('Content-Type', '').split(';')[0] != 'application/json' or handler.headers.get('Transfer-Encoding'):
        raise ValueError('JSON with Content-Length required')
    length = int(handler.headers.get('Content-Length', 0))
    max_length = 65536 if path == '/api/models/table' else 16384
    if not 2 <= length <= max_length:
        raise ValueError('Model request exceeds allowed body size')
    handler.connection.settimeout(60)
    raw = handler.rfile.read(length)
    if len(raw) != length:
        raise ValueError('Incomplete request')
    def reject(value):
        raise ValueError('Nonfinite JSON: ' + value)
    body = json.loads(raw, parse_constant=reject)
    if path == '/api/models/table':
        from .construction.model_tables import ModelTables
        if not isinstance(body, dict) or set(body) != {'request_id', 'dataset_id', 'definition'}:
            raise ValueError('Table request needs request_id, dataset_id and definition')
        return handler.send(ModelTables(workspace).build(q.get('project_id', ''), kind='snapshot', **body))
    if not isinstance(body, dict) or set(body)-{'request_id', 'doc_id', 'scene_id'}:
        raise ValueError('Only registered doc_id/scene_id and request_id are accepted')
    handler.send(ModelData(workspace).read(q.get('project_id', ''), **body))
