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
    service = ModelData(workspace)
    project = q.get('project_id', '')
    if path == '/api/models/datasets':
        result = service.list(project, int(q.get('offset', 0)), int(q.get('limit', 20)))
    elif path == '/api/models/query':
        result = service.query(project, q['dataset_id'], q.get('section', 'elements'), q.get('q', ''), q.get('native_id'),
            json.loads(q.get('filters', '[]')), q.get('cursor'), int(q.get('limit', 40)))
    elif path == '/api/models/object':
        result = service.object(project, q['dataset_id'], q['object_id'], json.loads(q.get('json_path', '[]')),
            int(q.get('offset', 0)), int(q.get('max_chars', 6000)), q.get('verify_source') == '1')
    else:
        return False
    handler.send(result)
    return True


def serve_post(handler, workspace, q):
    if handler.headers.get('Content-Type', '').split(';')[0] != 'application/json' or handler.headers.get('Transfer-Encoding'):
        raise ValueError('JSON with Content-Length required')
    length = int(handler.headers.get('Content-Length', 0))
    if not 2 <= length <= 16384:
        raise ValueError('Model read request exceeds 16 KiB')
    handler.connection.settimeout(60)
    raw = handler.rfile.read(length)
    if len(raw) != length:
        raise ValueError('Incomplete request')
    def reject(value):
        raise ValueError('Nonfinite JSON: ' + value)
    body = json.loads(raw, parse_constant=reject)
    if not isinstance(body, dict) or set(body)-{'request_id', 'doc_id', 'scene_id'}:
        raise ValueError('Only registered doc_id/scene_id and request_id are accepted')
    handler.send(ModelData(workspace).read(q.get('project_id', ''), **body))
