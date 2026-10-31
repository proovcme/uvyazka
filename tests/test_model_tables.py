"""Synthetic shared-engine, storage and export regressions; no private models."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from uvyazka.core import Workspace
from uvyazka.construction.model_tables import ModelTables,compute
from uvyazka.construction.rvt_catalog import RvtCatalog

HASH='a'*64

def catalogue():
    def row(eid,width,category=-2001140):
        return {'identity':{'element_id':eid},'class_name':'FamilyInstance','status':'read','source':{'stream':'synthetic','offset':eid},
                'saved_metadata':{'parameter_sets':[{'parameters':[{'serialized_parameter_id':-1001301,'raw_value':width,'storage_type':'Double'},
                    {'serialized_parameter_id':-1140363,'raw_value':category,'storage_type':'ElementId'}]}]}}
    return {'schema_version':1,'status':'read','clipped_records':0,'source':{'sha256':HASH,'filename':'synthetic.rvt','size_bytes':10},
        'records':[],'evaluated_schedule_body_available':False,'schedule_data':{'source_sha256':HASH,'status':'read',
        'scope':['FamilyInstance','FamilySymbol'],'records':[row(1,0),row(2,3),row(3,None)]}}


@unittest.skipUnless(importlib.util.find_spec('py_mini_racer'),'Install tables extra')
class TableTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name);source=root/'source';source.mkdir()
        self.ws=Workspace(root/'state');self.ws.create_project('one','Synthetic',source)
        self.ws.create_project('two','Other',source)
        self.tables=ModelTables(self.ws)
        self.cat=RvtCatalog(self.ws).save('one',catalogue(),'catalog')['extraction_id']

    def tearDown(self):self.tmp.cleanup()

    def test_engine_runs_from_an_async_mcp_context_and_preserves_unicode(self):
        async def run():return compute('describe',{})
        self.assertEqual(asyncio.run(run())['columns'][0]['label'],'Наименование')

    def test_same_engine_builds_filters_unknown_totals_and_immutable_requests(self):
        schema=self.tables.schema('one',self.cat)
        definition=schema['default_definition']
        width=next(c for c in self.tables.schema('one',self.cat,query='-1001301')['items'] if c.get('scope')=='instance')['id']
        definition['columns']=[{'id':'revit','label':'ID','aggregate':'none'},{'id':width,'label':'Width','aggregate':'sum'}]
        definition['filters']=[{'field_id':width,'operator':'greater','value':1,'unit':'ft'}]
        built=self.tables.build('one','first',self.cat,definition=definition)
        self.assertEqual(built['coverage']['passed'],1);self.assertEqual(built['coverage']['unknown'],1)
        self.assertEqual(self.tables.build('one','first',self.cat,definition=definition),built)
        self.assertEqual(self.tables.build('one','retry',self.cat,definition=definition),built)
        summary=self.tables.read('one',built['table_id'],'summary')
        self.assertEqual(summary['totals'][0]['cell']['value'],3)
        self.assertEqual(self.tables.read('one',built['table_id'])['items'][0]['cells'][0]['value'],'2')
        self.assertFalse(built['release_ready'])
        changed={**definition,'name':'Changed'}
        with self.assertRaisesRegex(ValueError,'request_id'):self.tables.build('one','first',self.cat,definition=changed)
        with self.assertRaisesRegex(ValueError,'not found'):self.tables.read('two',built['table_id'])
        export=self.tables.export('one',built['table_id'],'json')
        self.assertEqual(json.loads(Path(export['artifact']).read_text(encoding='utf8'))['coverage'],built['coverage'])
        self.assertTrue(Path(export['artifact']+'.source.json').is_file())
        fragment=self.tables.read('one',built['table_id'],'value',json_path=['rows'],max_chars=100)
        self.assertEqual(fragment['next_offset'],100)
        with self.assertRaises(ValueError):self.tables.export('one',built['table_id'],'xlsx')

    def test_native_only_physical_instances_can_form_gost_and_xlsx(self):
        schema=self.tables.schema('one',self.cat);definition=schema['default_definition'];settings=schema['gost_proposal']
        settings['categories']=['Mechanical Equipment'];definition['gost']=settings
        report=self.tables.build('one','gost',self.cat,kind='gost',definition=definition)
        self.assertEqual(report['row_count'],3);self.assertFalse(report['release_ready'])
        exported=self.tables.export('one',report['table_id'],'xlsx')
        with zipfile.ZipFile(exported['artifact']) as archive:
            self.assertIn('xl/worksheets/sheet1.xml',archive.namelist())
            self.assertIn('xl/worksheets/sheet2.xml',archive.namelist())

    def test_rejects_ambiguous_native_schedule_and_foreign_revision(self):
        schema=self.tables.schema('one',self.cat);definition=schema['default_definition'];definition['source_hashes']=['b'*64]
        with self.assertRaises(Exception):self.tables.build('one','foreign',self.cat,definition=definition)
        with self.assertRaises(Exception):self.tables.build('one','absent',self.cat,kind='native_schedule',element_id='42')
