"""Synthetic engineering cases only; no private project values or drawings."""
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.engineering_calculations import calculate
from uvyazka.engineering_work import EngineeringWork
from uvyazka.engineering_documents import EngineeringDocuments


def q(value,unit):return {'value':str(value),'unit':unit}


def electrical():return {'input_power':q(12,'kW'),'voltage':q(400,'V'),'power_factor':q(.8,'1'),'phases':3}


def test_typed_methods_and_intermediate_physical_results():
    result=calculate('electrical_current',electrical())
    assert float(result['results']['current']['value'])==pytest.approx(12000/(math.sqrt(3)*400*.8))
    assert result['trace'][0]['substitution']=='12000 / (1.73205080757 × 400 × 0.8)'
    inputs={'standby_current':q(200,'mA'),'alarm_current':q(.6,'A'),
            'standby_duration':q(12,'h'),'alarm_duration':q(30,'min'),
            'load_voltage':q(24,'V'),'battery_voltage':q(24,'V'),'battery_self_current':q(.02,'A'),
            'efficiency':q(.9,'1'),'usable_fraction':q(.8,'1'),'age_factor':q(1.2,'1')}
    result=calculate('battery_charge',inputs)
    assert float(result['results']['load_charge']['value'])==pytest.approx(2.7)
    assert float(result['results']['required_capacity']['value'])==pytest.approx(4.875)
    sound=calculate('sound_level',{'reference_level':q(90,'dBA'),'reference_distance':q(2,'m'),
                                  'distance':q(20,'m'),'additional_loss':q(5,'dB')})
    assert float(sound['results']['level']['value'])==pytest.approx(65)
    drop=calculate('voltage_drop',{'current':q(10,'A'),'voltage':q(230,'V'),
                    'conductor_resistance':q(.4,'ohm'),'conductor_reactance':q(0,'ohm'),
                    'power_factor':q(1,'1'),'phases':1})
    assert float(drop['results']['voltage_drop']['value'])==pytest.approx(8)
    heat=calculate('liquid_heat_flow',{'heat_power':q(20,'kW'),'specific_heat':q(4,'kJ/(kg·K)'),
                                    'temperature_difference':q(20,'delta_K'),'density':q(1000,'kg/m3')})
    assert float(heat['results']['mass_flow']['value'])==pytest.approx(.25)
    pipe=calculate('pipe_pressure_loss',{'volume_flow':q(math.pi*.1**2/4*2,'m3/s'),
                    'inside_diameter':q(100,'mm'),'length':q(25,'m'),'density':q(1000,'kg/m3'),
                    'darcy_friction_factor':q(.02,'1'),'local_loss_sum':q(3,'1')})
    assert float(pipe['results']['velocity']['value'])==pytest.approx(2)
    assert float(pipe['results']['pressure_loss']['value'])==pytest.approx(16000)
    geometry=calculate('enclosure_geometry',{'floor_area':q(10,'m2'),'height':q(3,'m'),'open_area':q(.03,'m2')})
    assert float(geometry['results']['leakage_parameter']['value'])==pytest.approx(.001)
    lighting=calculate('lighting_uniformity',{'minimum':q(5,'lx'),'mean':q(20,'lx'),'maximum':q(30,'lx')})
    assert float(lighting['results']['minimum_to_mean']['value'])==pytest.approx(.25)


def test_mixed_units_exact_port_rounding_and_false_claims_are_not_hidden():
    total=calculate('sum_products',{'rows':[{'quantity':'2','unit_value':q(100,'mA')},
                                          {'quantity':'3','unit_value':q(.2,'A')}]})
    assert float(total['results']['total']['value'])==pytest.approx(800)
    assert total['results']['total']['unit']=='mA'
    ports=calculate('port_budget',{'required_ports':q(100,'piece'),'available_ports':q(128,'piece'),
                                  'reserve_of_required':q(10,'%')})
    assert float(ports['results']['minimum_capacity']['value'])==110
    mismatch=calculate('electrical_current',electrical(),
        {'current':{'value':'1','unit':'A','tolerance':q(.1,'A')}},
        [{'output':'current','operator':'<=','value':q(5,'A'),'basis':'Synthetic boundary for this test'}])
    assert mismatch['reported_comparisons'][0]['status']=='differs'
    assert mismatch['criteria_checks'][0]['status']=='not_satisfied'
    assert mismatch['accepted'] is False


@pytest.mark.parametrize('value',[None,True,'NaN','Infinity','1e100','1e-100'])
def test_invalid_numbers_never_turn_into_zero(value):
    inputs=electrical();inputs['input_power']=q(value,'W')
    with pytest.raises(ValueError):calculate('electrical_current',inputs)


def test_wrong_dimensions_missing_inputs_and_invalid_domains():
    inputs=electrical();inputs['voltage']=q(400,'A')
    with pytest.raises(ValueError,match='Units'):calculate('electrical_current',inputs)
    inputs=electrical();inputs['power_factor']=q(0,'1')
    with pytest.raises(ValueError,match='domain'):calculate('electrical_current',inputs)
    inputs=electrical();inputs.pop('phases')
    with pytest.raises(ValueError,match='exactly'):calculate('electrical_current',inputs)
    with pytest.raises(ValueError,match='same surface'):
        calculate('lighting_uniformity',{'minimum':q(40,'lx'),'mean':q(20,'lx'),'maximum':q(30,'lx')})
    with pytest.raises(ValueError,match='whole'):
        calculate('port_budget',{'required_ports':q(1.5,'piece'),'available_ports':q(10,'piece'),'reserve_of_required':q(0,'1')})


@pytest.fixture
def project():
    with TemporaryDirectory() as folder:
        root=Path(folder);sources=root/'input';sources.mkdir()
        original=sources/'synthetic.csv';original.write_text('Input,12\n',encoding='utf-8')
        w=Workspace(root/'state');w.create_project('p','Synthetic engineering test',sources);scan(w,'p')
        record=w.find_documents('p')['documents'][0]
        source={'doc_id':record['doc_id'],'sha256':record['sha256'],'reason':'Synthetic input evidence'}
        yield w,original,source


def run(work,request='run-1',**extra):
    args=dict(calculation_id='load',title='Синтетическая нагрузка',method='electrical_current',inputs=electrical(),
              basis='Synthetic single operating case',sources=[],assumptions=['Synthetic input data'],request_id=request)
    args.update(extra);return work.run(**args)


def test_project_memory_idempotence_revisions_source_change_and_scope(project):
    w,original,source=project;work=EngineeringWork(w,'p')
    first=run(work,sources=[source],assumptions=[])
    assert run(work,sources=[source],assumptions=[])['revision']==1
    with pytest.raises(ValueError,match='different'):run(work,title='Changed title')
    with pytest.raises(ValueError,match='conflict'):run(work,request='run-2')
    with pytest.raises(ValueError,match='explanation'):run(work,request='run-2',expected_revision=1)
    revised=run(work,request='run-2',expected_revision=1,reason='Synthetic corrected assumption')
    assert revised['revision']==2
    assert work.get('calculation','load',1)['items'][0]['revision']==1
    original.write_text('Input,13\n',encoding='utf-8')
    assert not work.get('calculation','load',1)['items'][0]['current_sources']
    with pytest.raises(ValueError,match='Source changed'):run(work,request='run-3',sources=[source],expected_revision=2,reason='Refresh')
    w.create_project('other','Other synthetic project',original.parent)
    with pytest.raises(ValueError,match='Unknown'):EngineeringWork(w,'other').get('calculation','load')
    assert first['accepted'] is False


def metadata():return {'designation':'DEMO-E-01','project':'Синтетический пример',
                       'stage':'Р','organization':'Тестовая организация'}


def build(docs,**extra):
    args=dict(document_id='report',title='Расчёт и схема',metadata=metadata(),
              calculations=[{'calculation_id':'load','revision':1}],pages=[],symbols=[],basis='Synthetic layout test',
              sources=[],assumptions=[],request_id='document-1')
    args.update(extra);return docs.build(**args)


def test_generated_report_actual_pdf_checks_and_changed_calculation(project):
    pytest.importorskip('pymupdf')
    w,_,_=project;work=EngineeringWork(w,'p');run(work)
    docs=EngineeringDocuments(w,'p');first=build(docs)
    artifact=Path(first['data']['generation']['artifact'])
    before=artifact.read_bytes();assert before.startswith(b'%PDF')
    assert build(docs)['revision']==1
    checked=docs.check('check','Синтетическая проверка',[1],[
        {'kind':'page_size','width_mm':210,'height_mm':297,'tolerance_mm':.1,'basis':'Synthetic A4 profile'},
        {'kind':'frame','left_mm':20,'right_mm':5,'top_mm':5,'bottom_mm':5,'tolerance_mm':.1,'basis':'Synthetic frame profile'},
        {'kind':'required_text','text':'DEMO-E-01','basis':'Declared document designation'},
    ],'Synthetic profile','check-1',document_id='report')
    assert checked['data']['counts']=={'met':3,'not_met':0,'unchecked':0}
    failed=docs.check('wrong-profile','Synthetic wrong profile',[1],[
        {'kind':'page_size','width_mm':420,'height_mm':297,'tolerance_mm':.1,'basis':'Intentionally wrong synthetic size'},
        {'kind':'minimum_font_size','minimum_pt':20,'basis':'Intentionally unmet synthetic size'},
        {'kind':'required_text','text':'ABSENT-SYNTHETIC-FIELD','basis':'Intentionally absent field'},
    ],'Synthetic negative inspection','wrong-check',document_id='report')
    assert failed['data']['counts']=={'met':0,'not_met':3,'unchecked':0}
    assert artifact.read_bytes()==before
    run(work,request='correct',expected_revision=1,reason='Synthetic correction')
    assert not work.get('document','report')['items'][0]['current_calculations']
    assert not work.get('document_check','check')['items'][0]['current_document']
    with pytest.raises(ValueError,match='inputs changed'):
        docs.check('recheck','Review',[1],[{'kind':'required_text','text':'DEMO','basis':'Synthetic'}],
                   'Synthetic','recheck',document_id='report')


def test_vector_drawing_legend_overflow_and_artifact_integrity(project):
    pytest.importorskip('pymupdf')
    w,_,_=project;docs=EngineeringDocuments(w,'p')
    symbol={'id':'X1','label':'Датчик','basis':'Synthetic project-defined symbol',
            'entities':[{'type':'circle','center_mm':[0,0],'radius_mm':3}]}
    sheet={'format':'A3','title':'Синтетическая схема','entities':[
        {'type':'line','points_mm':[[30,40],[80,40]]},
        {'type':'symbol','symbol_id':'X1','origin_mm':[80,40]},
        {'type':'text','rect_mm':[30,50,100,65],'text':'Линия 1','font_size_pt':9}]}
    first=build(docs,calculations=[],pages=[sheet],symbols=[symbol],assumptions=['Synthetic vector geometry'])
    import pymupdf as fitz
    with fitz.open(first['data']['generation']['artifact']) as pdf:
        assert 'X1' in pdf[0].get_text()
        assert len(pdf[0].get_drawings())>2
    with pytest.raises(ValueError,match='Undefined'):
        build(docs,document_id='bad',request_id='bad',calculations=[],pages=[sheet],symbols=[],assumptions=['Synthetic'])
    bad={'format':'A4','title':'Overflow','entities':[{'type':'text','rect_mm':[25,25,30,27],
                'text':'Long synthetic text which cannot fit','font_size_pt':12}]}
    with pytest.raises(ValueError,match='overflow'):
        build(docs,document_id='overflow',request_id='overflow',calculations=[],pages=[bad],assumptions=['Synthetic'])
    artifact=Path(first['data']['generation']['artifact']);artifact.write_bytes(artifact.read_bytes()+b'tampered')
    with pytest.raises(ValueError,match='bytes changed'):
        docs.check('tamper','Integrity',[1],[{'kind':'required_text','text':'X1','basis':'Synthetic'}],
                   'Synthetic','tamper',document_id='report')


def test_raster_and_unsupported_checks_never_pass_from_missing_text(project):
    fitz=pytest.importorskip('pymupdf')
    w,original,_=project
    path=original.parent/'scan.pdf'
    with fitz.open() as pdf:pdf.new_page();pdf.save(path)
    scan(w,'p');record=w.find_documents('p',query='scan.pdf')['documents'][0]
    report=EngineeringDocuments(w,'p').check('scan','Scanned synthetic source',[1],[
        {'kind':'required_text','text':'Unseen field','basis':'Synthetic field requirement'},
        {'kind':'unknown_symbol_compliance','basis':'Synthetic unsupported rule'},
    ],'Synthetic','scan-check',doc_id=record['doc_id'],sha256=record['sha256'])
    assert report['data']['counts']=={'met':0,'not_met':0,'unchecked':2}


def test_stdio_calculate_build_check_and_restart(project):
    pytest.importorskip('pymupdf')
    mcp=pytest.importorskip('mcp')
    from mcp.client.stdio import stdio_client
    import asyncio
    import os
    import sys
    w,_,_=project

    async def exercise():
        params=mcp.StdioServerParameters(command=sys.executable,args=['-m','uvyazka.server'],
                env={**os.environ,'UVYAZKA_HOME':str(w.home),'PYTHONUTF8':'1'})
        for first in (True,False):
            async with stdio_client(params) as (read,write):
                async with mcp.ClientSession(read,write) as session:
                    await session.initialize()
                    async def call(name,**args):
                        response=await session.call_tool(name,args)
                        assert not response.isError,response
                        return json.loads(response.content[0].text)
                    if first:
                        methods=await call('list_engineering_methods')
                        assert len(methods['methods'])==10
                        listed={t.name:t for t in (await session.list_tools()).tools}
                        assert listed['get_engineering_work'].annotations.readOnlyHint
                        assert not listed['build_engineering_document'].annotations.readOnlyHint
                        await call('run_engineering_calculation',project_id='p',calculation_id='protocol',
                            title='Синтетический расчёт',method='electrical_current',inputs=electrical(),
                            basis='Synthetic protocol test',assumptions=['Synthetic inputs'],request_id='protocol-run')
                        assert (await call('engineering_document_schema'))['formats']['A4']==[210,297]
                        await call('build_engineering_document',project_id='p',document_id='protocol-report',
                            title='Синтетический отчёт',metadata=metadata(),basis='Synthetic protocol test',
                            calculations=[{'calculation_id':'protocol','revision':1}],request_id='protocol-build')
                    else:
                        saved=await call('get_engineering_work',project_id='p',kind='calculation',item_id='protocol')
                        assert saved['items'][0]['data']['inputs']==electrical()
                        checked=await call('check_engineering_document',project_id='p',check_id='protocol-check',
                            title='Synthetic persisted PDF check',pages=[1],document_id='protocol-report',
                            requirements=[{'kind':'required_text','text':'DEMO-E-01','basis':'Declared designation'}],
                            basis='Synthetic protocol test',request_id='protocol-check')
                        assert checked['data']['counts']['met']==1
    asyncio.run(asyncio.wait_for(exercise(),timeout=45))
