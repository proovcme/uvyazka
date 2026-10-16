"""Drawing adapters -> evidence -> standard IFC -> geometry -> event engine."""
import base64
from copy import deepcopy
import io
import json
from pathlib import Path

import ezdxf
import ifcopenshell
import numpy as np
from PIL import Image
import pymupdf
import pytest

from uvyazka.construction.authoring import DrawingProjects
from uvyazka.construction.drawings import inspect_source, render_source
from uvyazka.construction.model_spec import ModelSpec, DrawingFrame
from uvyazka.construction.model_preview import preview


def plan_file(directory, size=6., shift=0):
    path = directory / f'plan-{size}-{shift}.dxf'
    doc = ezdxf.new('R2010'); doc.units = ezdxf.units.MM
    ms = doc.modelspace()
    for start, end in [([shift, 0], [shift + size * 1000, 0]), ([shift + size * 1000, 0], [shift + size * 1000, 4000]),
                       ([shift + size * 1000, 4000], [shift, 4000]), ([shift, 4000], [shift, 0])]:
        ms.add_line(start, end, dxfattribs={'layer': 'wall-reference-face'})
    ms.add_text(f'L={size * 1000:g}; H=3000; T=200; door=1000x2100', dxfattribs={'insert': (shift, -300), 'height': 150})
    doc.saveas(path)
    return path


def model_spec(source_id, size=6., shift=0):
    evidence = [{'source_id': source_id, 'page': 1, 'basis': 'drawing_dimension', 'note': 'TEST: dimensions and wall reference lines in fixture DXF', 'frame_id': 'cad'}]
    def row(key, cls, geometry, **options):
        return {'id': key, 'ifc_class': cls, 'name': key, 'storey_id': 'L0', 'geometry': geometry, 'evidence': evidence, **options}
    return {'name': 'Synthetic drawing-driven integration fixture', 'units': 'm',
        'drawing_frames': [{'id': 'cad', 'source_id': source_id, 'page': 1, 'source_origin': [shift, 0],
            'model_origin': [0, 0], 'metres_per_unit': .001, 'description': 'DXF INSUNITS=millimetres, origin shifted to first wall reference'}],
        'storeys': [{'id': 'L0', 'name': 'Ground', 'elevation': 0, 'evidence': evidence}],
        'materials': [{'id': 'concrete', 'name': 'Concrete - Cast In Situ', 'color': [.65, .65, .6]}],
        'elements': [row('wall', 'IfcWall', {'kind': 'wall', 'start': [0, 0], 'end': [size, 0], 'height': 3, 'thickness': .2},
                         material_id='concrete', is_external=True, load_bearing=True),
            row('void', 'IfcOpeningElement', {'kind': 'opening', 'host_id': 'wall', 'offset': 1, 'width': 1, 'height': 2.1}),
            row('door', 'IfcDoor', {'kind': 'door', 'opening_id': 'void'}),
            row('floor', 'IfcSlab', {'kind': 'extrusion', 'outer': [[0, 0], [size, 0], [size, 4], [0, 4]], 'depth': .2, 'origin': [0, 0, -.2]}, predefined_type='FLOOR')],
        'assumptions': ['TEST fixture only; floor thickness is a deliberate test assumption, not interpreted from a real project']}


@pytest.fixture
def authoring(workspace_temp):
    directory = workspace_temp / 'authoring'; directory.mkdir(exist_ok=True)
    store = DrawingProjects(directory / 'cache', [directory])
    return directory, store


@pytest.mark.parametrize('size,shift', [(6, 0), (9.75, 500000)])
def test_drawing_ifc_pipeline_keeps_openings_units_provenance_and_runs(authoring, size, shift):
    directory, store = authoring
    source = plan_file(directory, size, shift); original = source.read_bytes()
    project = store.create('different project')
    registered = store.register_source(project['id'], 0, source.name, path=str(source))
    source_id = registered['source']['id']
    info = store.inspect(project['id'], source_id)
    assert info['length_to_m'] == .001 and len(info['entities']) >= 5
    assert Image.open(io.BytesIO(store.render(project['id'], source_id))).size == (2000, 2000)
    spec = model_spec(source_id, size, shift)
    store.set_spec(project['id'], 1, spec)
    built = store.build(project['id'], 2)
    build = built['build']; assert not build['validation']['express_errors']
    ifc = ifcopenshell.open(build['ifc_path'])
    assert ifc.schema == 'IFC4'
    assert len(ifc.by_type('IfcRelVoidsElement')) == 1
    assert len(ifc.by_type('IfcRelFillsElement')) == 1
    model, package = store.model(build['model_id'])
    wall_id = str(build['validation']['element_map']['wall']['step_id'])
    wall = next(e for e in model['elements'] if e['id'] == wall_id)
    assert wall['measured_quantities']['volume']['value'] == pytest.approx(size * .2 * 3 - 1 * .2 * 2.1, abs=1e-6)
    assert wall['property_sets']['IFCCS_DrawingProvenance']['InterpretationVerified'] is False
    assert source_id in wall['property_sets']['IFCCS_DrawingProvenance']['EvidenceJSON']
    assert wall['materials'] == ['Concrete - Cast In Situ']
    assert wall['property_sets']['Pset_WallCommon']['LoadBearing'] is True
    assert Image.open(io.BytesIO(preview(model, (package / 'geometry.bin').read_bytes()))).size == (1600, 1200)
    result = store.simulate(project['id']); assert result['status'] == 'completed'
    assert store.simulate(project['id']) == result
    assert original == source.read_bytes()
    new = deepcopy(spec['elements'][0]); new['name'] = 'renamed, same semantic identity'
    store.update_elements(project['id'], 3, [new])
    with pytest.raises(ValueError, match='актуальной сборки'):
        store.simulate(project['id'])
    second = store.build(project['id'], 4)
    assert second['build']['validation']['element_map']['wall']['global_id'] == build['validation']['element_map']['wall']['global_id']


def test_revision_evidence_validation_and_scoped_paths(authoring):
    directory, store = authoring
    source = plan_file(directory)
    key = store.create('revision and evidence')['id']
    registered = store.register_source(key, 0, source.name, path=str(source))
    with pytest.raises(ValueError, match='Конфликт ревизии'):
        store.register_source(key, 0, source.name, path=str(source))
    with pytest.raises(ValueError, match='корней'):
        store.register_source(key, 1, 'outside.pdf', path=str(Path(__file__).resolve()))
    with pytest.raises(ValueError):
        store.get('../escape')
    spec = model_spec(registered['source']['id'])
    invalid = deepcopy(spec); invalid['elements'][0]['geometry']['height'] = -3
    with pytest.raises(ValueError):
        store.set_spec(key, 1, invalid)
    invalid = deepcopy(spec); invalid['elements'][1]['geometry']['host_id'] = 'missing'
    with pytest.raises(ValueError, match='Проём'):
        store.set_spec(key, 1, invalid)
    invalid = deepcopy(spec); invalid['elements'][1]['geometry']['width'] = 100
    with pytest.raises(ValueError, match='габариты'):
        store.set_spec(key, 1, invalid)
    invalid = deepcopy(spec); invalid['storeys'][0]['evidence'][0]['page'] = 2
    with pytest.raises(ValueError):
        store.set_spec(key, 1, invalid)
    invalid = deepcopy(spec); invalid['elements'][0]['geometry']['run_code'] = 'anything'
    with pytest.raises(ValueError):
        store.set_spec(key, 1, invalid)
    assert store.get(key)['revision'] == 1
    store.set_spec(key, 1, spec)
    with pytest.raises(ValueError):
        store.update_elements(key, 2, [], ['wall'])
    assert store.get(key)['revision'] == 2


def test_pdf_raster_and_explicit_calibration(authoring):
    directory, store = authoring
    path = directory / 'plan.pdf'
    doc = pymupdf.open(); page = doc.new_page(width=600, height=400)
    page.draw_rect(pymupdf.Rect(50, 50, 550, 350))
    page.insert_text((50, 30), '5000 mm | Height 3000 mm')
    doc.save(path); doc.close()
    info = inspect_source(path, limit=1)
    assert '5000 mm' in info['texts'][0]['text'] and info['vector_total'] > 0
    assert Image.open(io.BytesIO(render_source(path))).width > 1000
    with pytest.raises(ValueError):
        render_source(path, region=[-1, 0, 10, 10])
    frame = DrawingFrame(id='pdf', source_id='source', page=1, source_origin=[50, 350], metres_per_unit=.01,
        source_y_down=True, description='500 page units = 5 metres')
    assert np.allclose(frame.transform([[550, 50]]), [[5, 3]])
    stream = io.BytesIO(); Image.new('RGB', (200, 100), 'white').save(stream, format='PNG')
    key = store.create('raster')['id']
    source = store.register_source(key, 0, 'scan.png', content_base64=base64.b64encode(stream.getvalue()).decode())
    assert source['source']['coordinate_unit'] == 'pixel'
    assert source['source']['length_to_m'] is None


def test_profile_holes_and_nonstandard_enum_rejected(authoring):
    directory, store = authoring; source = plan_file(directory)
    key = store.create('polygon holes')['id']
    registered = store.register_source(key, 0, source.name, path=str(source))
    spec = model_spec(registered['source']['id'])
    spec['elements'][3]['geometry']['holes'] = [[[2, 1], [3, 1], [3, 2], [2, 2]]]
    store.set_spec(key, 1, spec)
    built = store.build(key, 2)
    model, _ = store.model(built['build']['model_id'])
    floor_id = str(built['build']['validation']['element_map']['floor']['step_id'])
    assert next(e for e in model['elements'] if e['id'] == floor_id)['measured_quantities']['volume']['value'] == pytest.approx(4.6)
    invalid = deepcopy(spec); invalid['elements'][0]['predefined_type'] = 'MADE_UP_CLASSIFICATION'
    store.set_spec(key, 3, invalid)
    with pytest.raises(ValueError, match='стандартным'):
        store.build(key, 4)
    assert store.get(key)['active_build_id'] == built['build']['id']


def test_advertised_extrusion_classes_compile_as_real_ifc_entities(authoring):
    directory, store = authoring; source = plan_file(directory)
    key = store.create('IFC class geometry conformance, not a building')['id']
    registered = store.register_source(key, 0, source.name, path=str(source))
    spec = model_spec(registered['source']['id'])
    classes = ['IfcWall', 'IfcSlab', 'IfcRoof', 'IfcFooting', 'IfcColumn', 'IfcBeam', 'IfcMember', 'IfcStair',
        'IfcStairFlight', 'IfcRailing', 'IfcCovering', 'IfcFurnishingElement', 'IfcBuildingElementProxy', 'IfcSpace']
    base = deepcopy(spec['elements'][0]); base.pop('load_bearing', None); base.pop('is_external', None)
    base['evidence'][0]['basis'] = 'assumed'
    spec['elements'] = []
    for index, klass in enumerate(classes):
        row = deepcopy(base)
        row.update(id=f'object-{index}', name='Class geometry fixture only', ifc_class=klass,
            assumptions=['Cuboid tests the standard entity/geometry path only; not an architectural component'],
            geometry={'kind': 'extrusion', 'outer': [[0, 0], [1, 0], [1, 1], [0, 1]], 'depth': 1, 'origin': [index * 2, 0, 0]})
        if klass == 'IfcSpace':
            row['material_id'] = None
        spec['elements'].append(row)
    store.set_spec(key, 1, spec)
    built = store.build(key, 2)
    assert built['build']['validation']['element_count'] == len(classes)
    model = ifcopenshell.open(built['build']['ifc_path'])
    for klass in classes:
        assert len(model.by_type(klass, include_subtypes=False)) == 1
