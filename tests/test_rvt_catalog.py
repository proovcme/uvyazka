import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from uvyazka.core import Workspace, connection, encode
from uvyazka.construction.rvt_data import RvtData
from uvyazka.construction.rvt_catalog import RvtCatalog
from uvyazka.dashboard import make_handler
from test_rvt_data import fixture


def catalogue():
    schedule={**fixture(),'kind':'schedule'}
    sheet={**fixture(),'kind':'view','class_name':'DBViewDrafting','identity':{'element_id':'9007199254740993'},
           'graph':{'objects':[{'class_name':'DBViewDrafting','fields':{'m_viewName':'План','m_sheetNumber':'АР-1'}}],'edges':[]}}
    return {'schema_version':1,'schema_sha256':'b'*64,'status':'partial','clipped_records':1,
            'source':{'filename':'test.rvt','sha256':'a'*64,'size_bytes':123},'summary':{},
            'records':[schedule,sheet],'evaluated_schedule_body_available':False,
            'schedule_data':{'source_sha256':'a'*64,'status':'partial','scope':['FamilyInstance'],
                             'records':[{'identity':{'element_id':'77'},'class_name':'FamilyInstance','status':'complete',
                                         'source':{'stream':'Partitions/1'},'root_fields':{'m_name':'Насос'},
                                         'saved_metadata':fixture()['saved_metadata']}]}}


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name);source=root/'source';source.mkdir()
        self.workspace=Workspace(root/'state');self.workspace.create_project('one','One',source)
        self.workspace.create_project('two','Two',source)
        self.service=RvtCatalog(self.workspace)

    def test_browser_catalog_is_read_by_existing_mcp_store_and_roundtrips(self):
        doc=catalogue();saved=self.service.save('one',doc,'r1');key=saved['extraction_id']
        self.assertEqual(self.service.save('one',doc,'r1'),saved)
        self.assertEqual(self.service.save('one',doc,'r2'),saved)
        self.assertEqual(self.service.list('one')['total'],1)
        self.assertEqual(self.service.list('two')['total'],0)
        restored=self.service.for_source('one','a'*64)
        self.assertEqual(restored['records'],doc['records'])
        self.assertEqual(restored['schedule_data'],doc['schedule_data'])
        self.assertEqual(restored['status'],'partial')
        self.assertEqual(restored['shared_store']['source_verification'],'declared_sha256_not_reopened')
        data=RvtData(self.workspace)
        self.assertEqual(data.read('one',key,'schedules')['items'][0]['element_id'],'42')
        self.assertEqual(data.record('one',key,0,'schedule_cells')['items'][0]['properties']['m_text'],'')
        self.assertEqual(data.record('one',key,2,'parameters')['items'][0]['raw_value'],0)
        self.assertEqual(data.record('one',key,2,'fields')['items'][0]['raw_value'],'Насос')
        self.assertEqual(data.read('one',key,'coverage')['items'],[])
        with self.assertRaisesRegex(ValueError,'all-profile'):data.read('one',key,'systems')
        with self.assertRaises(ValueError):data.snapshot('two',key)
        self.assertIsNone(self.service.for_source('one','c'*64))

    def test_invalid_identity_hash_graph_and_request_reuse_never_mutate_a_snapshot(self):
        original=catalogue();saved=self.service.save('one',original,'r1')
        for mutate in [lambda d:d['schedule_data'].update(source_sha256='c'*64),
                       lambda d:d['records'][0]['identity'].update(element_id=9007199254740992),
                       lambda d:d['records'].append(copy.deepcopy(d['records'][0])),
                       lambda d:d['records'][0]['graph']['edges'][0].update(target_object_index=999),
                       lambda d:d.update(evaluated_schedule_body_available=True)]:
            bad=copy.deepcopy(original);mutate(bad)
            with self.assertRaises(ValueError):self.service.save('one',bad,'bad')
        changed=copy.deepcopy(original);changed['records'][0]['status']='partial'
        with self.assertRaisesRegex(ValueError,'different catalogue'):self.service.save('one',changed,'r1')
        self.assertEqual(self.service.document('one',saved['extraction_id'])['records'],original['records'])
        self.assertEqual(self.service.list('one')['total'],1)

    def test_native_mcp_records_project_into_viewer_without_a_browser_import(self):
        key='f'*64;db_path=RvtData(self.workspace).db('one')
        snapshot={'project_id':'one','extraction_id':key,'profile':'views','source':{'sha256':'a'*64,'filename':'native.rvt','size_bytes':123},'created_at':'2026-01-01','status':'partial','counts':{'schedule':1},'record_count':1}
        row=fixture()
        with connection(db_path) as db:
            db.execute('insert into rvt_extractions values (?,?)',(key,encode(snapshot)))
            db.execute('insert into rvt_native_records values (?,?,?,?,?,?,?,?)',(key,0,'42',row['class_name'],'schedule','Native','complete',encode(row)))
        result=self.service.for_source('one','a'*64)
        self.assertEqual(result['records'][0]['graph'],row['graph'])
        self.assertEqual(result['shared_store']['origin'],'native_extraction')
        self.assertFalse(result['evaluated_schedule_body_available'])

    def test_http_writes_require_local_origin_token_and_return_the_shared_snapshot(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.workspace))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
        base='http://127.0.0.1:'+str(server.server_port)
        with urlopen(base+'/api/rvt/catalog/config') as response:token=json.load(response)['write_token']
        def post(**headers):
            request=Request(base+'/api/rvt/catalog?project_id=one',data=encode({'document':catalogue(),'request_id':'http'}).encode(),headers={'Content-Type':'application/json','X-Uvyazka-Token':token,'Origin':base,**headers})
            with urlopen(request) as response:return json.load(response)
        for headers in [{'Origin':'https://foreign.test'},{'X-Uvyazka-Token':''},{'Host':'foreign.test'}]:
            with self.assertRaises(HTTPError) as error:post(**headers)
            self.assertEqual(error.exception.code,403)
        key=post()['extraction_id']
        self.assertEqual(RvtData(self.workspace).read('one',key,'views')['items'][0]['element_id'],'9007199254740993')
        with urlopen(base+'/api/rvt/catalog?project_id=one&source_sha256='+'a'*64) as response:
            self.assertEqual(json.load(response)['document']['shared_store']['extraction_id'],key)
        with urlopen(base+'/api/rvt/catalog?project_id=two&source_sha256='+'a'*64) as response:
            self.assertIsNone(json.load(response)['document'])
        def model_source(planning, project_id, model_id):
            if project_id!='one' or model_id!='legacy-model':raise ValueError('Unknown model in project')
            return {'source':{'sha256':'a'*64,'format':'rvt'}}
        with patch('uvyazka.construction.planning.Planning.model',model_source):
            with urlopen(base+'/api/rvt/catalog?project_id=one&model_id=legacy-model') as response:
                restored=json.load(response);self.assertEqual(restored['source'],{'sha256':'a'*64,'format':'rvt'})
                self.assertEqual(restored['document']['shared_store']['extraction_id'],key)
            with self.assertRaises(HTTPError):urlopen(base+'/api/rvt/catalog?project_id=two&model_id=legacy-model')


if __name__=='__main__':unittest.main()
