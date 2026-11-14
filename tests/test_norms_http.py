import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from uvyazka.core import Workspace
from uvyazka.dashboard import make_handler
from uvyazka.ingest import scan
from uvyazka.norms_http import backend


class NormsDashboardTests(unittest.TestCase):
    def test_normative_proxy_and_versioned_project_link(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'sources'; root.mkdir()
            (root / 'synthetic.txt').write_text('Synthetic normative reference', encoding='utf-8')
            workspace = Workspace(Path(folder) / 'state')
            workspace.create_project('synthetic', 'Synthetic normative test', root)
            scan(workspace, 'synthetic')
            source = workspace.find_documents('synthetic')['documents'][0]
            def remote(path, body=None):
                if path == '/health': result = {'name':'sp-mcp'}
                elif path == '/api/ui-config': result = {'write_token':'sp-test', 'search_requires_ai':False}
                elif path == '/api/uvyazka_prepare':
                    result = {'arguments': {'project_id':body['project_id'], 'analysis_id':'sp-synthetic',
                        'table_id':None, 'title':'Synthetic normative link', 'summary':'Unreviewed synthetic test',
                        'data':{'schema':'sp-mcp.uvyazka-link/1','accepted':False}, 'reader':'model',
                        'request_id':'synthetic-request', 'expected_revision':0,
                        'related_sources':[{'doc_id':source['doc_id'],'sha256':source['sha256'],'reason':'Synthetic reference'}]}}
                elif path == '/api/search': result = {'items':[], 'text_hits':[], 'model_used':False}
                else: return b'<!doctype html><title>SP MCP synthetic</title>', 'text/html', 200
                return json.dumps(result).encode(), 'application/json', 200
            with patch('uvyazka.norms_http.remote', side_effect=remote):
                server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(workspace))
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                base = f'http://127.0.0.1:{server.server_port}'
                try:
                    with urlopen(base+'/norms/') as response:
                        self.assertIn("frame-ancestors 'self'",response.headers['Content-Security-Policy'])
                    with urlopen(base+'/norms/api/ui-config') as response: config=json.load(response)
                    self.assertTrue(config['uvyazka_configured'])
                    def post(method, payload, token=True):
                        headers={'Content-Type':'application/json'}
                        if token: headers['X-Uvyazka-Token']=config['uvyazka_write_token']
                        return urlopen(Request(base+'/norms/api/'+method, data=json.dumps(payload).encode(), headers=headers))
                    with self.assertRaises(HTTPError) as error: post('search',{'query':'synthetic'},False)
                    self.assertEqual(error.exception.code,403)
                    with post('uvyazka_documents',{'project_id':'synthetic'}) as response:
                        self.assertEqual(json.load(response)['documents'][0]['sha256'],source['sha256'])
                    with post('uvyazka_attach',{'project_id':'synthetic'}) as response: saved=json.load(response)
                    self.assertTrue(saved['published']);self.assertFalse(saved['uvyazka_result']['accepted'])
                    with post('uvyazka_link_state',{'project_id':'synthetic','analysis_id':'sp-synthetic'}) as response:
                        self.assertEqual(json.load(response)['revision'],1)
                finally:
                    server.shutdown();server.server_close();thread.join()

    def test_backend_is_loopback_only(self):
        with patch.dict('os.environ', {'UVYAZKA_SP_URL':'http://example.invalid'}):
            with self.assertRaises(ValueError): backend()
