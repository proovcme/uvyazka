import copy
import csv
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from uvyazka.core import Workspace,encode
from uvyazka.ingest import scan
from uvyazka.construction.rvt_data import RvtData,project_record,kind_for


def fixture():
    objects=[{'class_name':name,'fields':fields} for name,fields in [
        ('DBViewSchedule',{'m_viewName':'Synthetic schedule','m_scale':1.,'m_pSchema':{'pointer_token':1,'offset':10},'m_pData':{'pointer_token':1,'offset':20}}),
        ('ScheduleSchema',{'m_fieldIds':[{'m_id':7}],'m_pFields':[{'pointer_token':1,'offset':30}]}),
        ('ScheduleField',{'m_columnHeading':'Count','m_hidden':False,'m_paramElemId':{'m_id':-100}}),
        ('ScheduleData',{'m_SectionData':[{'pointer_token':1,'offset':40}]}),
        ('ScheduleSectionData',{'m_index':1,'m_tableCells':[[{'pointer_token':1,'offset':50}]]}),
        ('TableCellData',{'m_row':0,'m_column':0,'m_text':'','m_paramId':{'m_id':-100}}),
        ('ScheduleField',{'m_columnHeading':'Unreferenced decoy'})]]
    edges=[{'source_object_index':a,'pointer_offset':b,'target_object_index':c} for a,b,c in [(0,10,1),(0,20,3),(1,30,2),(3,40,4),(4,50,5)]]
    return {'class_name':'DBViewSchedule','status':'complete_bounded_graph','identity':{'element_id':42,'unique_id':'synthetic-42'},
        'source':{'stream':'Partitions/67','body_sha256':'a'*64,'group_record_offset':100},
        'graph':{'objects':objects,'edges':edges},
        'saved_metadata':{'parameter_sets':[{'source_object':0,'parameters':[{'serialized_parameter_id':-100,'storage_type':'Integer','raw_value':0}]}]}}


class DataTests(unittest.TestCase):
    def test_mep_evidence_is_addressable_and_older_snapshots_remain_unknown(self):
        row=fixture()
        self.assertEqual(project_record(row,'mep_system')[0]['status'],'unavailable')
        row['mep_system']={'name':'П1','saved_name':'П1','class':'RbsHvacSystem','name_field':'m_strName',
            'members':[71], 'member_evidence':[{'element_id':71,'object_index':2,'field':'m_arrRefs','entry_index':0,'connection_type':1,'role':'network_member'}]}
        result=project_record(row,'mep_system')
        self.assertEqual(result[0]['member_count'],1)
        self.assertFalse(result[0]['engineering_connectivity_verified'])
        self.assertEqual(result[1]['json_path'],['graph','objects',2,'fields','m_arrRefs',0])
        row.pop('mep_system');row['mep_system_diagnostic']='missing explicit edge'
        self.assertEqual(project_record(row,'mep_system')[0]['diagnostic'],'missing explicit edge')

    def test_schedule_projection_uses_edges_order_and_preserves_empty_and_zero(self):
        row=fixture()
        fields=project_record(row,'schedule_fields')
        self.assertEqual(len(fields),1);self.assertEqual(fields[0]['field_id'],'7')
        self.assertIs(fields[0]['properties']['m_hidden'],False)
        cells=project_record(row,'schedule_cells')
        self.assertEqual(cells[0]['properties']['m_text'],'')
        self.assertEqual(cells[0]['properties']['m_row'],0)
        self.assertEqual(project_record(row,'parameters')[0]['raw_value'],0)
        broken=copy.deepcopy(row);broken['graph']['edges']=[]
        self.assertEqual(project_record(broken,'schedule_fields'),[])
        nested=copy.deepcopy(row)
        nested['graph']['objects'][4]['fields']['m_tableCells']=[{'pointer_token':1,'offset':60}]
        nested['graph']['objects'].append({'class_name':'TableRowCellData','fields':{'m_arrCells':[{'pointer_token':1,'offset':70}]}})
        nested['graph']['edges'].extend([{'source_object_index':4,'pointer_offset':60,'target_object_index':7},{'source_object_index':7,'pointer_offset':70,'target_object_index':5}])
        self.assertEqual(project_record(nested,'schedule_cells')[0]['properties']['m_text'],'')

    def test_cache_pages_source_changes_and_cross_project_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'sources';source.mkdir()
            file=source/'synthetic.rvt';file.write_bytes(bytes.fromhex('D0CF11E0A1B11AE1')+b'synthetic container')
            ws=Workspace(root/'state');ws.create_project('one','One',source)
            other=root/'other';other.mkdir();ws.create_project('two','Two',other)
            scan(ws,'one');doc=ws.find_documents('one','synthetic.rvt')['documents'][0]
            binary=root/'reader';binary.write_bytes(b'never executed fixture')
            classes=[{'name':'DBViewSchedule','parent':'TableView','fields':[]},{'name':'TableView','parent':'DBView','fields':[]},{'name':'DBView','parent':'Element','fields':[]}]
            def invoke(_,copied,request,output):
                if json.loads(request.read_text())['mode']=='inventory':output.write_text(encode({'classes':classes}),encoding='utf-8')
                else:
                    output.write_text(encode(fixture())+'\n',encoding='utf-8')
                    output.with_suffix('.summary.json').write_text(encode({'status':'extracted_requires_review','record_count':1,
                        'summary':{'unit_formats':{'synthetic:count':{'unit':'count'}},'parameter_definitions':{'42':{'name':'Count'}},
                            'classes':{'DBViewSchedule':{'records':1,'complete_graphs':1}}}}),encoding='utf-8')
            data=RvtData(ws)
            with patch('uvyazka.construction.rvt_data.binary_path',return_value=binary),patch.object(RvtData,'invoke',side_effect=invoke) as native:
                result=data.extract('one',doc['doc_id'],'extract','views')
                self.assertEqual(data.extract('one',doc['doc_id'],'extract','views'),result)
                self.assertEqual(data.extract('one',doc['doc_id'],'another','views'),result)
                self.assertEqual(native.call_count,2)
                key=result['extraction_id']
                with self.assertRaisesRegex(ValueError,'all-profile'):
                    data.read('one',key,'systems')
                page=data.read('one',key,'schedules',limit=1)
                self.assertEqual(page['items'][0]['element_id'],'42')
                record=data.record('one',key,0,'schedule_fields')
                self.assertFalse(record['evaluated_schedule_body_available'])
                path=record['items'][0]['json_path']
                value=data.record('one',key,0,'value',max_chars=10,json_path=path)
                self.assertEqual(value['next_offset'],10)
                view={r['field']:r['raw_value'] for r in data.record('one',key,0,'view')['items']}
                self.assertEqual(view['m_viewName'],'Synthetic schedule')
                self.assertTrue(data.record('one',key,0,'schedule_definition')['items'])
                self.assertEqual(data.read('one',key,'units')['items'][0]['key'],'synthetic:count')
                coverage=data.read('one',key,'coverage')['items'][0]
                self.assertEqual(coverage['properties']['records'],1)
                read=data.read('one',key,'value',json_path=coverage['json_path'])
                self.assertEqual(json.loads(read['json_text'])['records'],1)
                artifact=data.export_record('one',key,0)
                exported=json.loads(Path(artifact['artifact']).read_text(encoding='utf-8'))
                self.assertFalse(exported['requires_revit']);self.assertEqual(exported['record']['identity']['element_id'],42)
                artifact=data.export_record('one',key,0,'csv')
                with Path(artifact['artifact']).open(encoding='utf-8-sig',newline='') as stream:
                    cells=list(csv.DictReader(stream))
                self.assertEqual(json.loads(cells[0]['saved_text_json']),'')
                self.assertEqual(cells[0]['row'],'0')
                self.assertEqual(cells[0]['has_calculated_value'],'False')
                self.assertEqual(artifact['row_count'],1)
                self.assertEqual(data.export_record('one',key,0,'csv')['row_count'],1)
                self.assertTrue(Path(artifact['artifact']+'.source.json').is_file())
                with self.assertRaises(ValueError):data.read('two',key)
                with self.assertRaises(ValueError):data.record('one',key,0,'value',json_path=['missing'])
                file.write_bytes(file.read_bytes()+b'changed')
                with self.assertRaises(ValueError):data.extract('one',doc['doc_id'],'extract','views')

    def test_class_inheritance_does_not_classify_an_energy_schedule_as_a_view(self):
        classes={'DBViewPlan':{'parent':'DBView'},'EnergyAnalysisSchedule':{'parent':None}}
        self.assertEqual(kind_for('DBViewPlan',classes),'view')
        self.assertEqual(kind_for('EnergyAnalysisSchedule',classes),'element')
