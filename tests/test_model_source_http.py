"""Synthetic saved observations; verify exact download bytes and race rejection."""
import hashlib
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from urllib.error import HTTPError
from unittest.mock import patch
from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.model_data import ModelData
from uvyazka.model_readers import obj
from uvyazka.dashboard import make_handler


class OriginalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name);source=root/'sources';source.mkdir()
        self.original=source/'Example.dxf';self.raw=b'synthetic CAD byte-transfer fixture';self.original.write_bytes(self.raw)
        self.ws=Workspace(root/'state');self.ws.create_project('example','Synthetic source',source);scan(self.ws,'example')
        self.doc=self.ws.find_documents('example')['documents'][0]['doc_id']
        with patch('uvyazka.model_readers.reader_status',return_value={'readers':{'dxf':{'available':True,'engine':'synthetic transfer','revision':'1'}}}),patch('uvyazka.model_readers.dxf_data',return_value=([obj('elements','2F','Example','TEXT',{})],{'status':'partial','limitations':['Synthetic observation; not a CAD decoding test']})):
            self.saved=ModelData(self.ws).read('example','read',doc_id=self.doc)
        self.object=ModelData(self.ws).query('example',self.saved['dataset_id'])['items'][0]['object_id']
        self.server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.ws))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.addCleanup(self.close)
    def close(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=5)
    def url(self,**overrides):
        q={'project_id':'example','dataset_id':self.saved['dataset_id'],'object_id':self.object,'sha256':hashlib.sha256(self.raw).hexdigest(),**overrides}
        return f'http://127.0.0.1:{self.server.server_port}/api/models/original?'+urlencode(q)
    def test_exact_source_and_identity_are_required(self):
        with urlopen(self.url()) as response:
            self.assertEqual(response.read(),self.raw)
            self.assertEqual(response.headers['X-Uvyazka-Source-SHA256'],hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(self.original.read_bytes(),self.raw)
        for args in [{'object_id':'wrong'},{'sha256':'f'*64}]:
            with self.assertRaises(HTTPError):urlopen(self.url(**args))
        with patch('uvyazka.model_source_http.MAX_CAD_SOURCE',4):
            with self.assertRaises(HTTPError) as error:urlopen(self.url())
            self.assertEqual(error.exception.code,413)
    def test_change_after_preflight_never_returns_unverified_bytes(self):
        source_record=self.ws.source_record;calls=0
        def mutate(project,doc_id,**kwargs):
            nonlocal calls
            calls+=1
            if calls==2:self.original.write_bytes(b'other revision')
            return source_record(project,doc_id,**kwargs)
        with patch.object(self.ws,'source_record',side_effect=mutate):
            with self.assertRaises(HTTPError) as error:urlopen(self.url())
            self.assertEqual(error.exception.code,409)

    def test_viewer_head_matches_get_headers_without_body(self):
        with urlopen(f'http://127.0.0.1:{self.server.server_port}/simulation/') as response:
            body=response.read();headers=response.headers
        with urlopen(Request(f'http://127.0.0.1:{self.server.server_port}/simulation/',method='HEAD')) as response:
            self.assertEqual(response.read(),b'')
            self.assertEqual(response.headers['Content-Length'],headers['Content-Length'])
            self.assertEqual(response.headers['Content-Type'],headers['Content-Type'])
            self.assertEqual(response.headers['Content-Security-Policy'],headers['Content-Security-Policy'])
        self.assertGreater(len(body),0)
        with self.assertRaises(HTTPError) as error:urlopen(Request(self.url(),method='HEAD'))
        self.assertEqual(error.exception.code,405)
