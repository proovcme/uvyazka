"""Synthetic snapshots: shared persistence, typed filters and safe local API."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from urllib.request import urlopen, Request
from urllib.error import HTTPError

from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.model_data import ModelData
from uvyazka.model_readers import obj, json_value
from uvyazka.model_navis import project_navis
from uvyazka.dashboard import make_handler


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root/'sources'; self.source.mkdir()
        self.file = self.source/'synthetic.ifc'; self.file.write_text('synthetic metadata fixture', encoding='utf-8')
        self.ws = Workspace(root/'state')
        self.ws.create_project('one', 'One', self.source)
        other = root/'other'; other.mkdir(); self.ws.create_project('two', 'Two', other)
        scan(self.ws, 'one')
        self.doc = self.ws.find_documents('one')['documents'][0]['doc_id']
        self.service = ModelData(self.ws)
        self.rows = [obj('elements', '9007199254740993', 'Pump', 'IfcPump', {'power': 0, 'nullable': None}, identifiers={'element_id': '9007199254740993'}),
                     obj('elements', '42', 'Fan', 'IfcFan', {'power': 10}),
                     obj('systems', 'sys', 'Supply', 'IfcSystem', {})]
        self.status = patch('uvyazka.model_readers.reader_status', return_value={'readers': {'ifc': {'available': True, 'engine': 'synthetic', 'revision': 'v1'}}})
        self.status.start(); self.addCleanup(self.status.stop)
        self.adapter = patch('uvyazka.model_readers.ifc_data', side_effect=lambda _: (copy.deepcopy(self.rows), {'status': 'partial', 'limitations': ['synthetic subset']}))
        self.native = self.adapter.start(); self.addCleanup(self.adapter.stop)

    def read(self, request='first'):
        return self.service.read('one', request, self.doc)

    def test_cache_restart_idempotence_changes_and_scope(self):
        before = self.ws.db_path('two').read_bytes()
        self.assertEqual(self.service.list('two')['items'], [])
        self.assertEqual(before, self.ws.db_path('two').read_bytes())
        first = self.read()
        self.assertEqual(first['dataset_id'], ModelData(self.ws).read('one', 'again', self.doc)['dataset_id'])
        self.assertEqual(self.native.call_count, 1)
        self.assertEqual(self.file.read_text(), 'synthetic metadata fixture')
        with self.assertRaises(ValueError): self.service.dataset('two', first['dataset_id'])
        with self.assertRaises(ValueError): self.service.read('one', 'first', scene_id='other')
        self.file.write_text('changed fixture', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'scan'): self.read('new')
        scan(self.ws, 'one')
        changed = self.read('new')
        self.assertNotEqual(first['dataset_id'], changed['dataset_id'])
        old = self.service.dataset('one', first['dataset_id'], True)
        self.assertFalse(old['current_registered_version'])
        self.assertEqual(old['freshness']['status'], 'different_registered_version')
        self.assertTrue(changed['current_registered_version'])
        self.assertEqual(self.service.list('one')['total'], 2)

    def test_typed_filters_ids_and_field_continuation(self):
        key = self.read()['dataset_id']
        found = self.service.query('one', key, native_id='9007199254740993')
        self.assertEqual(len(found['items']), 1)
        oid = found['items'][0]['object_id']
        zero = self.service.query('one', key, filters=[{'path': ['properties', 'power'], 'op': 'eq', 'value': 0}])
        self.assertEqual(zero['items'][0]['object_id'], oid)
        wrong = self.service.query('one', key, filters=[{'path': ['properties', 'power'], 'op': 'eq', 'value': False}])
        self.assertEqual(wrong['items'], [])
        exists = self.service.query('one', key, filters=[{'path': ['properties', 'nullable'], 'op': 'exists', 'value': True}])
        self.assertEqual(len(exists['items']), 1)
        self.assertEqual(json.loads(self.service.object('one', key, oid, ['properties', 'nullable'])['text']), None)
        text = ''; offset = 0
        while True:
            part = self.service.object('one', key, oid, offset=offset, max_chars=100)
            text += part['text']
            if part['next_offset'] is None: break
            offset = part['next_offset']
        self.assertEqual(json.loads(text)['identifiers']['element_id'], '9007199254740993')
        with self.assertRaises(KeyError): self.service.object('one', key, oid, ['properties', 'absent'])

    def test_model_source_anchor_survives_scan_and_supports_shared_analysis(self):
        from uvyazka.structure_analysis import StructureAnalysis
        data = self.read()
        self.assertTrue(data['current_registered_version'])
        scan(self.ws, 'one')
        self.assertEqual(self.ws.source_record('one', self.doc)[0]['sha256'], data['source']['sha256'])
        analyses = StructureAnalysis(self.ws, 'one')
        result = analyses.save('synthetic-model', None, 'Model reading', 'Synthetic interpretation',
            {'dataset_id':data['dataset_id'], 'checks':[]}, 'model', 'model-analysis',
            related_sources=[{'doc_id':self.doc,'sha256':data['source']['sha256'],'reason':'Native model field'}])
        self.assertEqual(result['revision'], 1)
        resumed = analyses.read('synthetic-model')
        self.assertTrue(resumed['items'][0]['current_sources'])

    def test_empty_filtered_batch_keeps_cursor_and_rejects_changed_query(self):
        self.rows = [obj('elements', str(i), 'Unmatched', '', {'hit': i == 2001}) for i in range(2002)]
        key = self.read()['dataset_id']
        filters = [{'path': ['properties', 'hit'], 'op': 'eq', 'value': True}]
        page = self.service.query('one', key, filters=filters)
        self.assertEqual(page['items'], []); self.assertIsNotNone(page['next_cursor'])
        second = self.service.query('one', key, filters=filters, cursor=page['next_cursor'])
        self.assertEqual(second['items'][0]['native_id'], '2001'); self.assertIsNone(second['next_cursor'])
        with self.assertRaises(ValueError): self.service.query('one', key, query='changed', cursor=page['next_cursor'])

    def test_duplicate_ids_and_source_mutation_never_publish(self):
        self.rows.append(copy.deepcopy(self.rows[0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'): self.read()
        self.assertEqual(self.service.list('one')['total'], 0)
        self.rows.pop()
        def mutate(_):
            self.file.write_text('concurrent edit')
            return self.rows, {'status': 'partial'}
        self.native.side_effect = mutate
        with self.assertRaisesRegex(ValueError, 'changed during'): self.read()
        self.assertEqual(self.service.list('one')['total'], 0)

    def test_local_http_shares_dataset_rejects_unauthorized_paths_and_cross_origin(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.ws))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:'+str(server.server_port)
        try:
            with urlopen(base+'/api/models/status') as response: token = json.load(response)['write_token']
            route = base+'/api/models/read?project_id=one'
            body = json.dumps({'doc_id': self.doc, 'request_id': 'http'}).encode()
            for headers in [{}, {'X-Uvyazka-Token': token, 'Origin': 'https://untrusted.invalid'}]:
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(route, body, headers={'Content-Type': 'application/json', **headers}))
                self.assertEqual(error.exception.code, 403)
            with urlopen(Request(route, body, headers={'Content-Type': 'application/json', 'X-Uvyazka-Token': token})) as response:
                key = json.load(response)['dataset_id']
            self.assertEqual(self.service.list('one')['items'][0]['dataset_id'], key)
            with urlopen(base+'/api/models/query?project_id=one&dataset_id='+key+'&native_id=42') as response:
                result = json.load(response)
            self.assertEqual(result, self.service.query('one', key, native_id='42'))
            with self.assertRaises(HTTPError):
                urlopen(Request(route, b'{"request_id":"bad","path":"outside.ifc"}', headers={'Content-Type':'application/json', 'X-Uvyazka-Token':token}))
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_navis_exact_id_and_unknown_reference_are_retained(self):
        model = {'namespace':'n', 'objects':[
            {'serialized_id':1, 'values':{'internal':'LcRevitId','display':'Element ID'}},
            {'serialized_id':2,'type_reference':1,'serialized_class':66,'values':{'uint64_decimal':'9007199254740993'}}],
            'nodes':[{'index':0,'serialized_id':100,'attributes':[{'serialized_id':2},{'serialized_id':404}]}]}
        rows, report = project_navis([model])
        self.assertEqual(rows[0]['identifiers']['element_id'], '9007199254740993')
        self.assertFalse(rows[0]['quantity_eligible'])
        self.assertEqual(len(rows[0]['diagnostics']['unresolved_references']), 1)
        self.assertEqual(report['status'], 'partial')
        self.assertEqual(json_value(float('nan'))['state'], 'nonfinite')

    def test_saved_viewer_scene_is_shared_but_never_claims_original_reread(self):
        import hashlib
        from uvyazka.construction.geometry import box_model
        from uvyazka.construction.coordination_store import CoordinationStore
        model, binary = box_model('Synthetic model', [{'id':'one','name':'Object', 'bbox_min_m':[0,0,0],
            'bbox_max_m':[1,1,1], 'geometry_basis':'synthetic cuboid'}], [], [])
        store = CoordinationStore(self.ws)
        receipt = store.begin_scene('one', model, hashlib.sha256(binary).hexdigest())
        store.scene_chunk('one', receipt['scene_id'], 0, binary)
        data = self.service.read('one', 'viewer', scene_id=receipt['scene_id'])
        self.assertFalse(data['source']['original_file_reopened'])
        self.assertEqual(data['freshness']['status'], 'derived_package_only')
        self.assertEqual(self.service.query('one', data['dataset_id'])['items'][0]['native_id'], 'one')
        with self.assertRaises(ValueError): self.service.read('two','foreign',scene_id=receipt['scene_id'])


class OptionalFormatTests(unittest.TestCase):
    def test_synthetic_dxf_blocks_layers_attributes_and_layouts(self):
        try: import ezdxf
        except ImportError: self.skipTest('optional ezdxf')
        from uvyazka.model_readers import dxf_data
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'drawing.dxf'
            drawing = ezdxf.new(); drawing.layers.new('MEP'); block = drawing.blocks.new('Pump')
            block.add_circle((0,0),1)
            ref = drawing.modelspace().add_blockref('Pump',(1,2),dxfattribs={'layer':'MEP'})
            ref.add_attrib('MARK', 'P1'); drawing.saveas(path)
            rows, report = dxf_data(path)
            json.dumps([rows, report], allow_nan=False)
            self.assertTrue(any(r['name']=='MEP' for r in rows if r['section']=='layers'))
            insert = next(r for r in rows if r['category']=='INSERT')
            self.assertEqual(insert['properties']['attributes'][0]['text'], 'P1')
            self.assertEqual(insert['layer'], 'MEP')

    def test_synthetic_ifc_properties_and_identity(self):
        try: import ifcopenshell
        except ImportError: self.skipTest('optional IFC')
        import ifcopenshell.api
        from uvyazka.model_readers import ifc_data
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'model.ifc'
            model = ifcopenshell.file(schema='IFC4')
            pump = ifcopenshell.api.run('root.create_entity', model, ifc_class='IfcPump', name='Synthetic pump')
            pset = ifcopenshell.api.run('pset.add_pset',model,product=pump,name='Synthetic')
            ifcopenshell.api.run('pset.edit_pset',model,pset=pset,properties={'Power':0., 'Mark':'P1'})
            model.write(str(path))
            rows, report = ifc_data(path)
            json.dumps([rows, report], allow_nan=False)
            row = next(r for r in rows if r['category']=='IfcPump')
            self.assertEqual(row['identifiers']['global_id'], pump.GlobalId)
            self.assertEqual(row['properties']['property_sets']['Synthetic']['Power'], 0.)


if __name__ == '__main__': unittest.main()
