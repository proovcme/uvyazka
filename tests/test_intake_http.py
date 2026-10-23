import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer
import zipfile

from uvyazka.core import Workspace
from uvyazka.dashboard import make_handler
from uvyazka.intake import ProjectIntake


TEXT = "Synthetic document: area is 12 m2; this is a source observation. " * 3


class IntakeHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.ws=Workspace(self.root/'state')
        self.server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.ws))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base='http://127.0.0.1:'+str(self.server.server_port)
        self.token=self.get('/api/intake/runtime')['write_token']

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()

    def get(self,path):
        with urlopen(self.base+path,timeout=15) as response:return json.load(response)

    def post(self,path,body,raw=False,headers=None):
        data=body if raw else json.dumps(body).encode()
        fields={'Content-Type':'application/octet-stream' if raw else 'application/json','X-Uvyazka-Token':self.token}
        fields.update(headers or {})
        with urlopen(Request(self.base+path,data=data,headers=fields),timeout=15) as response:return json.load(response)

    def wait(self,key):
        for _ in range(200):
            job=self.get('/api/intake/jobs?intake_id='+key)
            if job['status'] in {'ready','partial','failed'} and not job['running']:return job
            time.sleep(.025)
        self.fail('Intake did not finish')

    def test_empty_workspace_has_intake_and_protected_writes(self):
        self.assertEqual(self.get('/api/projects')['projects'],[])
        with urlopen(self.base+'/') as response:
            page=response.read().decode()
        self.assertIn('Добавить проект',page);self.assertIn('/intake.js',page)
        for path in ['/intake.js','/intake.css']:
            with urlopen(self.base+path) as response:self.assertGreater(len(response.read()),50)
        body={'source_root':str(self.root),'name':'Untrusted'}
        for fields in [{'X-Uvyazka-Token':''},{'Origin':'https://other.invalid'}]:
            with self.assertRaises(HTTPError) as error:self.post('/api/intake/folder',body,headers=fields)
            self.assertEqual(error.exception.code,403)
        self.assertEqual(self.get('/api/projects')['projects'],[])
        with self.assertRaises(HTTPError) as error:self.post('/api/intake/folder',{'source_root':''})
        self.assertEqual(error.exception.code,400)

    def test_ui_folder_handoff_to_model_and_back_uses_same_memory(self):
        data=TEXT.encode();job=self.post('/api/intake/start',{'mode':'folder_upload','name':'UI project','files':[{'path':'ПД/AR.txt','size':len(data)}]})
        from urllib.parse import urlencode
        self.post('/api/intake/file?'+urlencode({'intake_id':job['intake_id'],'path':'ПД/AR.txt'}),data,raw=True)
        self.post('/api/intake/finish',{'intake_id':job['intake_id']})
        ready=self.wait(job['intake_id']);self.assertEqual(ready['status'],'ready',ready)
        model=Workspace(self.ws.home);project=ready['project_id']
        self.assertEqual(ProjectIntake(model).get(job['intake_id'])['counts']['documents'],1)
        doc=model.find_documents(project)['documents'][0]
        model.record_observations(project,[{'id':'area','name':'Area','group':'tep','value':'12','raw_value':'12','unit':'m2','basis':'floor',
            'sources':[{'doc_id':doc['doc_id'],'sha256':doc['sha256'],'page_number':1}]}],'model-continues-ui')
        facts=self.get('/api/facts?project_id='+project)['facts']
        self.assertEqual(facts[0]['id'],'area')
        self.assertEqual(self.get('/api/status?project_id='+project)['counts']['facts'],1)
        linked=self.post('/api/intake/folder',{'source_root':ready['source_root']})
        self.assertEqual(linked['project_id'],project)
        self.wait(linked['intake_id'])
        self.assertEqual(len(self.get('/api/projects')['projects']),1)

    def test_zip_and_local_path_share_registration_and_status_routes(self):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as archive:archive.writestr('AR.txt',TEXT)
        job=self.post('/api/intake/start',{'mode':'zip_upload','name':'ZIP'})
        self.post('/api/intake/archive?intake_id='+job['intake_id'],stream.getvalue(),raw=True)
        result=self.wait(job['intake_id']);self.assertEqual(result['status'],'ready')
        source=self.root/'local';source.mkdir();(source/'AR.txt').write_text(TEXT,encoding='utf-8')
        folder=self.post('/api/intake/folder',{'source_root':str(source),'name':'Linked folder'})
        self.wait(folder['intake_id'])
        self.assertEqual(len(self.get('/api/projects')['projects']),2)
        again=self.post('/api/intake/resume',{'intake_id':folder['intake_id']})
        self.wait(again['intake_id'])
        self.assertEqual(self.get('/api/intake/jobs?project_id='+folder['project_id'])['items'][0]['project_id'],folder['project_id'])
