"""GUI writes and model tools share one project history, with loopback guards."""
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from uvyazka.core import Workspace
from uvyazka.demo import create_demo
from uvyazka.dashboard import make_handler
from uvyazka.construction.coordination_store import CoordinationStore
from test_clashes import fixture,rule


class ReviewHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.ws=Workspace(Path(self.temp.name)/'state');create_demo(self.ws)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.ws))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base='http://127.0.0.1:'+str(self.server.server_port)
        self.token=self.get('/api/review3d/config')['token']

    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def get(self,path):
        with urlopen(self.base+path) as r:return json.load(r)
    def post(self,path,body,**headers):
        headers={'Content-Type':'application/json','X-Uvyazka-Token':self.token,**headers}
        raw=body if isinstance(body,bytes) else json.dumps(body).encode()
        with urlopen(Request(self.base+path,data=raw,headers=headers)) as r:return json.load(r)

    def test_shared_history_guards_and_compare_and_export(self):
        path='/api/review3d/save?project_id=demo-a'
        body={'kind':'clash_template','id':'test','payload':rule(),'expected_revision':0,'request_id':'gui-one'}
        for headers in [{'X-Uvyazka-Token':'bad'},{'Origin':'https://untrusted.invalid'},{'Host':'not-loopback.invalid'}]:
            with self.assertRaises(HTTPError) as ex:self.post(path,body,**headers)
            self.assertEqual(ex.exception.code,403)
        self.assertEqual(self.post(path,body)['revision'],1)
        store=CoordinationStore(self.ws)
        self.assertEqual(store.get('demo-a','clash_template','test')['payload']['name'],rule()['name'])
        body.update(request_id='gui-conflict')
        with self.assertRaises(HTTPError) as ex:self.post(path,body)
        self.assertEqual(ex.exception.code,409)
        self.assertEqual(self.get('/api/review3d/objects?project_id=demo-b&kind=clash_template')['items'],[])
        model,binary=fixture([([0,0,0],[2,2,2]),([1,1,1],[3,3,3])])
        scene=self.post('/api/review3d/scene-start?project_id=demo-a',{'model':model,'binary_sha256':hashlib.sha256(binary).hexdigest()})
        chunk='/api/review3d/scene-chunk?project_id=demo-a&scene_id='+scene['scene_id']+'&offset=0'
        self.assertTrue(self.post(chunk,binary,**{'Content-Type':'application/octet-stream'})['ready'])
        job=self.post('/api/review3d/run?project_id=demo-a',{'scene_id':scene['scene_id'],'rule':rule(),'request_id':'http-run'})
        for _ in range(60):
            result=self.get('/api/review3d/job?project_id=demo-a&id='+job['job_id'])
            if result['status'] not in {'queued','running'}:break
            time.sleep(.02)
        self.assertEqual(result['status'],'complete');self.assertEqual(len(result['report']['issues']),1)
        saved=store.get('demo-a','clash_run',job['job_id'])
        self.assertEqual(saved['payload']['geometry_sha256'],hashlib.sha256(binary).hexdigest())
        for fmt in ('bcf','xlsx'):
            with urlopen(self.base+'/api/review3d/export?project_id=demo-a&run_id='+job['job_id']+'&format='+fmt) as response:self.assertTrue(response.read().startswith(b'PK'))

    def test_desktop_routes_disabled_by_default_and_backup_blocks_further_writes(self):
        with self.assertRaises(HTTPError) as ex:self.get('/api/desktop/config')
        self.assertEqual(ex.exception.code,404)
        self.server.desktop_embed=True
        request=Request(self.base+'/api/desktop/config',headers={'Origin':'http://tauri.localhost'})
        with urlopen(request) as response:
            self.assertEqual(response.headers['Access-Control-Allow-Origin'],'http://tauri.localhost')
            self.assertIn('UVYAZKA_HOME',json.load(response)['clients']['Codex'])
        copied=self.post('/api/desktop/backup',{},Origin='http://tauri.localhost')
        self.assertGreater(copied['databases'],1)
        self.assertTrue((Path(copied['path'])/'registry.sqlite3').is_file())
        with self.assertRaises(HTTPError) as ex:self.post('/api/review3d/save?project_id=demo-a',{})
        self.assertEqual(ex.exception.code,503)


if __name__=='__main__':unittest.main()
