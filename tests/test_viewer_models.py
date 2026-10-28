import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import threading
from http.server import ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from uvyazka.core import Workspace
from uvyazka.demo import create_demo
from uvyazka.construction.geometry import box_model
from uvyazka.construction.coordination_store import CoordinationStore
from uvyazka.construction.viewer_models import register_viewer_model,validate_package
from uvyazka.construction.planning import Planning
from uvyazka.dashboard import make_handler


class ViewerModelTests(unittest.TestCase):
    def test_protected_gui_registration_is_visible_to_common_model_reader_after_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Workspace(Path(folder)/'state');create_demo(ws);server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(ws));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base='http://127.0.0.1:'+str(server.server_port)
            try:
                def get(path):
                    with urlopen(base+path,timeout=10) as response:return json.load(response)
                token=get('/api/review3d/config?project_id=demo-a')['token']
                def post(path,value,content='application/json',authenticated=True):
                    raw=json.dumps(value).encode() if content=='application/json' else value
                    headers={'Content-Type':content,'Origin':base}
                    if authenticated:headers['X-Uvyazka-Token']=token
                    with urlopen(Request(base+'/api/review3d/'+path+'?project_id=demo-a',data=raw,headers=headers),timeout=10) as response:return json.load(response)
                model,binary=box_model('Synthetic GUI source',[{'id':'one','name':'Synthetic object','bbox_min_m':[0,0,0],'bbox_max_m':[1,1,1],'geometry_basis':'synthetic cuboid'}],[],[])
                started=post('scene-start',{'model':model,'binary_sha256':hashlib.sha256(binary).hexdigest()})
                path='/api/review3d/scene-chunk?project_id=demo-a&scene_id='+started['scene_id']+'&offset=0'
                with urlopen(Request(base+path,data=binary,headers={'Content-Type':'application/octet-stream','Origin':base,'X-Uvyazka-Token':token}),timeout=10) as response:self.assertTrue(json.load(response)['ready'])
                body={'scene_id':started['scene_id'],'request_id':'synthetic-gui-registration'}
                with self.assertRaises(HTTPError) as rejected:post('register-model',body,authenticated=False)
                self.assertEqual(rejected.exception.code,403)
                result=post('register-model',body)
                reopened=Workspace(ws.home);self.assertEqual(Planning(reopened).model_elements('demo-a',result['model_id'])['items'][0]['id'],'one')
                loaded=get('/api/construction/model?project_id=demo-a&model_id='+result['model_id']);self.assertEqual(loaded['registration']['approval_status'],'unreviewed')
            finally:server.shutdown();server.server_close();thread.join(timeout=5)

    def test_same_project_registry_roundtrip_and_idempotency(self):
        with tempfile.TemporaryDirectory() as folder:
            ws=Workspace(Path(folder)/'state');create_demo(ws)
            model,binary=box_model('Synthetic viewer source',[{'id':'one','name':'Synthetic object','bbox_min_m':[0,0,0],'bbox_max_m':[1,1,1],'geometry_basis':'synthetic cuboid'}],[],[])
            store=CoordinationStore(ws);job=store.begin_scene('demo-a',model,hashlib.sha256(binary).hexdigest());store.scene_chunk('demo-a',job['scene_id'],0,binary)
            result=register_viewer_model(ws,'demo-a',job['scene_id'],'synthetic-registration')
            self.assertEqual(result,register_viewer_model(ws,'demo-a',job['scene_id'],'synthetic-registration'))
            package=Planning(ws).model('demo-a',result['model_id']);self.assertFalse(package['registration']['original_file_reopened']);self.assertEqual(package['registration']['approval_status'],'unreviewed')
            self.assertEqual(Planning(ws).model_elements('demo-a',result['model_id'])['items'][0]['id'],'one')
            self.assertEqual((Planning(ws).model_path('demo-a',result['model_id'])/'geometry.bin').read_bytes(),binary)
            altered=copy.deepcopy(model);altered['source']['filename']='Synthetic conflict'
            next_job=store.begin_scene('demo-a',altered,hashlib.sha256(binary).hexdigest());store.scene_chunk('demo-a',next_job['scene_id'],0,binary)
            with self.assertRaisesRegex(ValueError,'another package'):register_viewer_model(ws,'demo-a',next_job['scene_id'],'conflict')
            self.assertEqual(Planning(ws).model('demo-a',result['model_id'])['source']['filename'],model['source']['filename'])

    def test_invalid_ranges_and_duplicate_ids_are_rejected(self):
        model,binary=box_model('Synthetic',[{'id':'one','name':'Synthetic object','bbox_min_m':[0,0,0],'bbox_max_m':[1,1,1],'geometry_basis':'synthetic'}],[],[])
        validate_package(model,binary)
        broken=copy.deepcopy(model);broken['elements'].append(broken['elements'][0])
        with self.assertRaisesRegex(ValueError,'Unique'):validate_package(broken,binary)
        broken=copy.deepcopy(model);broken['elements'][0]['mesh']['index_byte_offset']=len(binary)
        with self.assertRaisesRegex(ValueError,'ranges'):validate_package(broken,binary)
