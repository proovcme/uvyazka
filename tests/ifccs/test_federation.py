from copy import deepcopy
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from uvyazka.construction.federation import create_federation
from uvyazka.construction.importer import write_json
from uvyazka.construction.revit_metadata import phase_context, phase_status, phase_projection
from uvyazka.construction.planner import build_scenario
from uvyazka.construction.simulation import SimulationEngine
from uvyazka.construction.quantities import quantity


def element(key, family, lower, upper, **fields):
    return {'id':str(key), 'step_id':key, 'global_id':'same-source-guid-'+str(key), 'name':family,
        'class':family, 'hierarchy':[family,'IfcElement','IfcProduct'], 'role':'element','storey_id':'10',
        'predefined_type':None,'materials':[],'property_sets':{},'quantity_sets':{},'quantities':{},
        'measured_quantities':{},'geometry_error':None,
        'mesh':{'bbox_min_m':lower,'bbox_max_m':upper,'vertex_count':8,'index_count':36,
            'position_byte_offset':0,'index_byte_offset':96,'styles':[],'groups':[],'representation_id':100}, **fields}


def model(rows):
    return {'contract':'ModelPackage','contract_version':'0.1.0','importer_version':'test',
        'model_id':'a'*64,'source':{'filename':'synthetic.ifc','sha256':'a'*64,'size_bytes':100,'schema':'IFC4'},
        'elements':rows,'relationships':[], 'storeys':[{'id':'10','name':'Level','elevation_m':0,'element_count':len(rows)}],
        'diagnostics':[], 'coordinate_system':{'render_origin_m':[0,0,0]},'statistics':{}}


def test_federation_scopes_duplicate_ids_and_preserves_rigid_placement_and_sources(workspace_temp):
    cache=workspace_temp/'federation';source=cache/'models'/('a'*64);source.mkdir(parents=True)
    vertices=np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],dtype='<f4')
    indices=np.array([0,1,2]*12,dtype='<u4')
    data=model([element(1,'IfcWall',[0,0,0],[1,1,1])]);write_json(source/'manifest.json',data)
    (source/'geometry.bin').write_bytes(vertices.tobytes()+indices.tobytes())
    before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}
    members=[{'model_id':'a'*64,'instance_id':'one'}, {'model_id':'a'*64,'instance_id':'two','offset_m':[10,20,30],'rotation_deg':90}]
    result=create_federation(cache,members);assert result==create_federation(cache,members)
    target=cache/'models'/result['model_id'];scene=json.loads((target/'manifest.json').read_text(encoding='utf8'))
    assert {r['id'] for r in scene['elements']}=={'one:1','two:1'}
    second=scene['elements'][1];mesh=second['mesh'];origin=np.array(scene['coordinate_system']['render_origin_m'])
    rendered=np.frombuffer((target/'geometry.bin').read_bytes(),dtype='<f4',offset=mesh['position_byte_offset'],count=24).reshape(-1,3)+origin
    assert np.allclose(rendered,vertices@np.array([[0,1,0],[-1,0,0],[0,0,1]])+[10,20,30])
    assert second['source_element_id']=='1' and second['storey_id']=='two:10'
    assert {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}==before
    with pytest.raises(ValueError,match='уникальный'):
        create_federation(cache,[members[0],members[0]])


def phases():
    return {'status':'read','phases':[{'id':'91','name':'Before','order':0},{'id':'3','name':'After','order':1}]}


@pytest.mark.parametrize('created,demolished,selection,expected',[
    ('91',None,'3','existing'),('3',None,'3','new'),('3',None,'91','future'),
    ('91','3','3','demolition'),('3','3','3','temporary'),('91','91','3','absent'),
    ('999',None,'3','unknown'),('91','999','3','unknown'),('91',None,'all','unknown')])
def test_phase_lifecycle_uses_stored_order_not_phase_id(created,demolished,selection,expected):
    m={'revit':phases()};ctx=phase_context(m,{'model':selection})
    e={'revit':{'phase_status':'read','phase_created_id':created,'phase_demolished_id':demolished}}
    assert phase_status(e,ctx)==expected


def test_native_phase_order_has_schema_evidence_and_names_are_not_guessed():
    def record(key,cls,fields):
        return {'identity':{'element_id':key},'class_name':cls,'status':'complete_bounded_graph',
            'root_fields':fields,'source':{'body_sha256':'proof','stream':'Partitions/1'}}
    native={'records':[record(0,'AllProjectPhases',{'m_phaseIds':[{'m_id':{'m_id64':91}},{'m_id':{'m_id64':3}}]}),
        record(91,'ProjectPhase',{'m_name':'Existing'}),record(3,'ProjectPhase',{'m_name':'New'})]}
    p=phase_projection(native);assert p['phase_order_known']
    assert [x['id'] for x in p['phases']]==['91','3']
    native['records']=native['records'][1:]
    p=phase_projection(native);assert not p['phase_order_known']
    assert all(x['order'] is None for x in p['phases'])


def engineering_model(length=5):
    slab=element(1,'IfcSlab',[0,0,-.2],[12,10,0])
    duct=element(2,'IfcDuctSegment',[1,1,3],[1+length,1.3,3.3], hierarchy=['IfcDuctSegment','IfcFlowSegment','IfcElement'],
        measured_quantities={'length':quantity(length,'m','explicit','fixture_length')})
    fitting=element(3,'IfcDuctFitting',[1+length-.1,1,3],[1+length+.2,1.3,3.3],hierarchy=['IfcDuctFitting','IfcFlowFitting','IfcElement'])
    wall=element(4,'IfcWall',[0,0,0],[12,.2,4],property_sets={'Pset_WallCommon':{'IsExternal':True}})
    return model([slab,duct,fitting,wall])


def test_mep_access_and_commissioning_share_one_acyclic_event_graph():
    scenario=build_scenario(engineering_model());run=SimulationEngine(scenario).run()
    assert run['status']=='completed'
    mep=[u for u in scenario['units'] if u['construction_role']=='mep'];assert len(mep)==2
    assert any(a['kind']=='facade_scaffold' for a in scenario['temporary_assets'])
    floor_ops=[o for o in scenario['operations'] if o.get('unit_id')=='1']
    assert all('scaffold_access' not in o['demands'] and 'access_tower' not in o['demands'] for o in floor_ops)
    for asset in scenario['temporary_assets']:
        states=run['operation_states'];setup,check,remove=[states[asset[k]] for k in ('install_id','check_id','remove_id')]
        assert setup['finish']<=check['start']
        for oid in asset['work_operation_ids']:
            assert check['finish']<=states[oid]['start']
            assert states[oid]['finish']<=remove['start']
    for group in scenario['mep_systems']:
        gate=run['operation_states'][group['operation_id']]['start']
        assert group['connectivity_verified'] is False
        assert all(run['operation_states'][u['operation_ids'][-1]]['finish']<=gate for u in mep)
    assert SimulationEngine(scenario).run()==run
    longer=SimulationEngine(build_scenario(engineering_model(9))).run()
    assert (next(o for o in longer['scenario']['operations'] if o['kind']=='duct_install')['duration'] >
        next(o for o in scenario['operations'] if o['kind']=='duct_install')['duration'])


def test_existing_elements_are_not_rebuilt_and_demolition_is_explicit():
    m=engineering_model();m['revit']=phases()
    for e in m['elements']:e['revit']={'phase_status':'read','phase_created_id':'91','phase_demolished_id':None}
    m['elements'][1]['revit']['phase_demolished_id']='3'
    s=build_scenario(m);assert '1' in s['initial_element_ids']
    assert not any('1' in o['target_ids'] for o in s['operations'])
    assert any(o['kind']=='demolition' and '2' in o['target_ids'] for o in s['operations'])
