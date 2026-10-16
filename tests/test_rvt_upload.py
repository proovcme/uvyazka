import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

from uvyazka.core import Workspace,digest
from uvyazka.dashboard import make_handler
from uvyazka.ingest import scan
from uvyazka.construction.rvt_upload import RvtUploads


class UploadTests(unittest.TestCase):
    def test_scoped_upload_pipeline_origin_and_preserved_source_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);sources=root/'sources';sources.mkdir();(sources/'original.txt').write_text('Original source',encoding='utf-8')
            ws=Workspace(root/'state');ws.create_project('one','One',sources)
            other=root/'other';other.mkdir();ws.create_project('two','Two',other)
            body=bytes.fromhex('D0CF11E0A1B11AE1')+b'synthetic upload transport fixture'
            calls=[]
            def prepared(workspace,project,doc,request,**options):
                document,path=workspace.source_record(project,doc)
                self.assertEqual(path.read_bytes(),body);self.assertEqual(document['sha256'],digest(path))
                calls.append((project,doc));options['progress']('extracting')
                return {'project_id':project,'status':'partial','requires_revit':False,'stages':
                    {'data':{'status':'partial','record_count':1,'counts':{'view':1}},'geometry':{'status':'failed','error':'Synthetic unsupported geometry'}},'crosswalk':None}
            with patch('uvyazka.construction.rvt_upload.prepare',side_effect=prepared):
                server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(ws));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
                base='http://127.0.0.1:'+str(server.server_port)
                def get(path):
                    with urlopen(base+path) as response:return json.load(response)
                try:
                    runtime=get('/api/rvt/runtime?project_id=one');token=runtime['upload_token']
                    route='/api/rvt/upload?project_id=one&filename=synthetic.rvt'
                    headers={'Content-Type':'application/octet-stream','X-Uvyazka-Token':token}
                    for changed in [{'X-Uvyazka-Token':'wrong'},{'Origin':'https://example.invalid'},{'Host':'unexpected.invalid'}]:
                        with self.assertRaises(HTTPError) as error:urlopen(Request(base+route,data=body,headers={**headers,**changed}))
                        self.assertEqual(error.exception.code,403)
                    with self.assertRaises(HTTPError):urlopen(Request(base+route.replace('synthetic.rvt','../escaped.rvt'),data=body,headers=headers))
                    with self.assertRaises(HTTPError):urlopen(Request(base+route,data=b'not a Revit file',headers=headers))
                    with urlopen(Request(base+route,data=body,headers=headers)) as response:
                        self.assertEqual(response.status,202);job=json.load(response)
                    for _ in range(100):
                        result=get('/api/rvt/job?project_id=one&job_id='+job['job_id'])
                        if result['status'] in {'completed','failed'}:break
                        time.sleep(.02)
                    self.assertEqual(result['status'],'completed');self.assertEqual(result['result']['status'],'partial')
                    document,target=ws.source_record('one',job['doc_id'])
                    self.assertTrue(target.is_relative_to(ws.db_path('one').parent));self.assertEqual(target.read_bytes(),body)
                    self.assertEqual(sorted(p.name for p in sources.iterdir()),['original.txt'])
                    scan(ws,'one');self.assertEqual(ws.source_record('one',job['doc_id'])[0]['index_status'],'uploaded_rvt')
                    self.assertEqual(ws.source_state('one',job['doc_id'],full_hash=True)['status'],'content_hash_matches')
                    with self.assertRaises(HTTPError):get('/api/rvt/job?project_id=two&job_id='+job['job_id'])
                    self.assertEqual(len(calls),1)
                    with urlopen(base+'/rvt.js') as response:self.assertIn(b'UvyazkaRvt',response.read())
                finally:server.shutdown();server.server_close();thread.join()

    def test_stream_failure_cleanup_and_project_state_containment(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'sources';source.mkdir();ws=Workspace(root/'state');ws.create_project('one','One',source)
            uploads=RvtUploads(ws)
            with self.assertRaises(ValueError):uploads.receive('one','incomplete.rvt',30,io.BytesIO(bytes.fromhex('D0CF11E0A1B11AE1')))
            self.assertFalse(list(ws.home.rglob('*.part')))
            with self.assertRaises(ValueError):uploads.receive('one','large.rvt',513*1024*1024,io.BytesIO())
            for _ in range(4):self.assertTrue(uploads.slots.acquire(blocking=False))
            self.assertFalse(uploads.slots.acquire(blocking=False))
