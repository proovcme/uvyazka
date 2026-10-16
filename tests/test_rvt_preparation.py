import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from uvyazka.core import Workspace,connection,encode,digest
from uvyazka.ingest import scan
from uvyazka.construction.rvt_data import RvtData
from uvyazka.construction.rvt_preparation import prepare


class PreparationTests(unittest.TestCase):
    def make_workspace(self,root):
        folder=root/'sources';folder.mkdir()
        source=folder/'synthetic.rvt';source.write_bytes(bytes.fromhex('D0CF11E0A1B11AE1')+b'pipeline fixture')
        ws=Workspace(root/'state');ws.create_project('one','Synthetic pipeline',folder)
        scan(ws,'one');doc=ws.find_documents('one',source.name)['documents'][0]
        return ws,doc['doc_id'],source

    def test_both_stages_crosswalk_and_repeat(self):
        with tempfile.TemporaryDirectory() as directory:
            ws,doc,source=self.make_workspace(Path(directory));original=digest(source);data=RvtData(ws)
            extraction='a'*64;model_id='b'*64
            with connection(data.db('one')) as db:
                db.execute('insert into rvt_extractions values (?,?)',(extraction,'{}'))
                for i,key in enumerate(['42','43']):db.execute('insert into rvt_native_records values (?,?,?,?,?,?,?,?)',(extraction,i,key,'Element','element','','complete_bounded_graph','{}'))
            native={'extraction_id':extraction,'status':'extracted_requires_review','record_count':2,'counts':{'element':2}}
            model={'model_id':model_id,'source':{'conversion':{'ifc_validation_errors':0}},
                'elements':[{'id':'ifc-1','revit':{'element_id':'42'}},{'id':'ifc-2'}]}
            with patch.object(RvtData,'extract',return_value=native) as extract,patch('uvyazka.construction.rvt_preparation.import_rvt_document',return_value={'model_id':model_id}) as convert,patch('uvyazka.construction.rvt_preparation.Planning.model',return_value=model):
                result=prepare(ws,'one',doc,'prepare')
                self.assertEqual(result['status'],'prepared_requires_review')
                self.assertFalse(result['requires_revit'])
                crosswalk=result['crosswalk'];self.assertEqual(crosswalk['matched_geometry_rows'],1)
                self.assertEqual(crosswalk['native_records_not_in_geometry'],1)
                links=json.loads(Path(crosswalk['artifact']).read_text(encoding='utf-8'))['links']
                self.assertEqual(links[0]['native_record_id'],0)
                self.assertIsNone(links[1]['native_record_id'])
                self.assertEqual(prepare(ws,'one',doc,'prepare'),result)
                self.assertEqual(extract.call_count,1);self.assertEqual(convert.call_count,1)
                with self.assertRaises(ValueError):prepare(ws,'one',doc,'prepare',False)
                self.assertEqual(digest(source),original)
                source.write_bytes(source.read_bytes()+b'changed')
                with self.assertRaises(ValueError):prepare(ws,'one',doc,'prepare')

    def test_stage_failures_preserve_other_stage_and_optional_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            ws,doc,source=self.make_workspace(Path(directory))
            native={'extraction_id':'a'*64,'status':'partial','record_count':1,'counts':{'view':1}}
            with patch.object(RvtData,'extract',return_value=native),patch('uvyazka.construction.rvt_preparation.import_rvt_document',side_effect=ValueError('unsupported geometry')) as convert:
                result=prepare(ws,'one',doc,'partial')
                self.assertEqual(result['status'],'partial')
                self.assertEqual(result['stages']['data']['extraction_id'],'a'*64)
                self.assertEqual(result['stages']['geometry']['status'],'failed')
                result=prepare(ws,'one',doc,'data-only',False)
                self.assertEqual(result['stages']['geometry']['status'],'not_requested')
                self.assertEqual(convert.call_count,1)
            model={'model_id':'b'*64,'source':{'conversion':{}},'elements':[]}
            with patch.object(RvtData,'extract',side_effect=ValueError('unsupported data')),patch('uvyazka.construction.rvt_preparation.import_rvt_document',return_value={'model_id':'b'*64}),patch('uvyazka.construction.rvt_preparation.Planning.model',return_value=model):
                result=prepare(ws,'one',doc,'geometry-only')
                self.assertEqual(result['status'],'partial')
                self.assertEqual(result['stages']['data']['status'],'failed')
                self.assertEqual(result['stages']['geometry']['status'],'converted_requires_review')
            def change(*args):source.write_bytes(source.read_bytes()+b'changed');return native
            with patch.object(RvtData,'extract',side_effect=change),patch('uvyazka.construction.rvt_preparation.import_rvt_document') as convert:
                with self.assertRaises(ValueError):prepare(ws,'one',doc,'changed-in-flight')
                convert.assert_not_called()
