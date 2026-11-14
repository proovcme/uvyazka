"""Model-free normative library proxy; SP MCP owns its single shared normative database."""
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

ASSETS = {'app.js': 'text/javascript', 'style.css': 'text/css', 'mark.svg': 'image/svg+xml'}
METHODS = {'sources', 'search', 'browse', 'open', 'read', 'outline', 'read_clause', 'search_document',
           'table', 'check', 'batch_check', 'compare', 'library', 'document', 'contents', 'verifications', 'search_status', 'prepare_search', 'uvyazka_prepare'}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('SP service redirects are not allowed')


def backend():
    value = os.getenv('UVYAZKA_SP_URL', 'http://127.0.0.1:8767').rstrip('/')
    parsed = urlsplit(value)
    if (parsed.scheme not in {'http', 'https'} or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path):
        raise ValueError('UVYAZKA_SP_URL must be a loopback HTTP(S) origin')
    return value


def remote(path, body=None):
    origin = backend()
    headers = {'Content-Type': 'application/json', 'Origin': origin}
    token = os.getenv('UVYAZKA_SP_TOKEN')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = Request(origin + path, data=None if body is None else json.dumps(body).encode('utf-8'),
                      headers=headers, method='GET' if body is None else 'POST')
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=120 if body is not None else 5) as response:
            data = response.read(12 * 1024 * 1024 + 1)
            if len(data) > 12 * 1024 * 1024:
                raise ValueError('SP response exceeds 12 MiB')
            return data, response.headers.get('Content-Type', 'application/json'), response.status
    except HTTPError as exc:
        raw = exc.read(256 * 1024)
        return raw, exc.headers.get('Content-Type', 'application/json'), exc.code
    except (URLError, TimeoutError, OSError) as exc:
        raise ValueError('SP MCP недоступен. Запустите sp-mcp web и повторите подключение.') from exc


def serve_get(handler, workspace, token, path, query):
    if path == '/api/norms/status':
        try:
            raw, _, status = remote('/health')
            result = json.loads(raw)
            handler.send({'ready': status == 200 and result.get('name') == 'sp-mcp',
                          'url': backend(), 'search_requires_ai': False})
        except ValueError:
            handler.send({'ready': False, 'url': backend(), 'search_requires_ai': False,
                          'message': 'Запустите sp-mcp web, затем повторите подключение.'})
        return True
    if not path.startswith('/norms/'):
        return False
    relative = path[len('/norms'):]
    if relative != '/' and relative != '/api/ui-config' and relative not in {'/assets/'+name for name in ASSETS}:
        handler.send({'error': 'Unknown normative library resource'}, status=404)
        return True
    try:
        raw, mime, status = remote(relative)
        if relative == '/api/ui-config' and status == 200:
            data = json.loads(raw)
            data.update(uvyazka_write_token=token, uvyazka_configured=True, embedded_in_uvyazka=True)
            handler.send(data)
        else:
            handler.send(raw, mime, status)
    except ValueError as exc:
        handler.send({'error_code': 'SP_UNAVAILABLE', 'message': str(exc)}, status=503)
    return True


def serve_post(handler, workspace, path):
    """Dashboard has already checked its Host, Origin and per-session write token."""
    if not path.startswith('/norms/api/'):
        raise ValueError('Unknown normative action')
    if handler.headers.get('Transfer-Encoding') or handler.headers.get('Content-Type', '').split(';')[0] != 'application/json':
        raise ValueError('JSON with Content-Length required')
    size = int(handler.headers.get('Content-Length', 0))
    if not 2 <= size <= 65536:
        raise ValueError('Normative request exceeds 64 KiB')
    handler.connection.settimeout(150)
    raw = handler.rfile.read(size)
    if len(raw) != size:
        raise ValueError('Incomplete normative request')
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise ValueError('JSON object required')
    method = path.removeprefix('/norms/api/')
    if method == 'uvyazka_projects':
        return handler.send(workspace.list_projects())
    if method == 'uvyazka_documents':
        return handler.send(workspace.find_documents(body['project_id'], body.get('query', ''), 30,
                                                     int(body.get('offset', 0))))
    if method == 'uvyazka_link_state':
        from .structure_analysis import StructureAnalysis
        result = StructureAnalysis(workspace, body['project_id']).list(query=body['analysis_id'], limit=100)
        items = [item for item in result.get('items', []) if item['analysis_id'] == body['analysis_id']
                 and item['reader'] == 'model']
        return handler.send({'revision': max((item['revision'] for item in items), default=0)})
    if method == 'uvyazka_attach':
        from .structure_analysis import StructureAnalysis
        raw, _, status = remote('/api/uvyazka_prepare', body)
        payload = json.loads(raw)
        if status != 200:
            return handler.send(payload, status=status)
        arguments = payload['arguments']
        # Resolve project/source and optimistic revision in Uvyazka's own application core.
        project_id = arguments.pop('project_id')
        if project_id != body['project_id']:
            raise ValueError('Normative link project mismatch')
        result = StructureAnalysis(workspace, project_id).save(**arguments)
        return handler.send({'published': True, 'project_id': project_id, 'uvyazka_result': result})
    if method not in METHODS:
        return handler.send({'error_code': 'METHOD_NOT_FOUND'}, status=404)
    raw, mime, status = remote('/api/' + method, body)
    return handler.send(raw, mime, status)
