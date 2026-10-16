"""Dimensional correctness, evidence and resource sensitivity (not snapshots)."""
from copy import deepcopy
import math

import ifcopenshell
import numpy as np
import pytest

from uvyazka.construction.quantities import explicit_quantities, mesh_quantities, quantity, unit_quantities
from uvyazka.construction.production import calculate_duration, production_profile, work_for
from uvyazka.construction.planner import build_scenario
from uvyazka.construction.simulation import SimulationEngine


def cube(size=(2., 3., 4.), offset=(0., 0., 0.)):
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], dtype=float) * size + offset
    f = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                  [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]])
    return v, f


def test_mesh_volume_is_translation_rotation_invariant_and_open_mesh_has_no_volume():
    v, f = cube()
    q = mesh_quantities(v, f)
    assert q['volume']['value'] == pytest.approx(24)
    assert q['form_sides']['value'] == pytest.approx(40)
    assert q['form_soffit']['value'] == pytest.approx(6)
    angle = .73
    rotation = np.array([[math.cos(angle), -math.sin(angle), 0], [math.sin(angle), math.cos(angle), 0], [0, 0, 1]])
    moved = mesh_quantities(v @ rotation + [1e6, -2e6, 90], f)
    assert moved['volume']['value'] == pytest.approx(24)
    assert moved['form_sides']['value'] == pytest.approx(40)
    assert 'volume' not in mesh_quantities(v, f[:-1])


def test_qto_project_and_explicit_units_are_independent_of_length_units():
    m = ifcopenshell.file(schema='IFC4')
    mm = m.createIfcSIUnit(UnitType='LENGTHUNIT', Prefix='MILLI', Name='METRE')
    cubic = m.createIfcSIUnit(UnitType='VOLUMEUNIT', Name='CUBIC_METRE')
    mm3 = m.createIfcSIUnit(UnitType='VOLUMEUNIT', Prefix='MILLI', Name='CUBIC_METRE')
    assignment = m.createIfcUnitAssignment([mm, cubic])
    m.create_entity('IfcProject', GlobalId=ifcopenshell.guid.new(), UnitsInContext=assignment)
    wall = m.create_entity('IfcWall', GlobalId=ifcopenshell.guid.new())
    def assign(unit, value):
        q = m.create_entity('IfcQuantityVolume', Name='NetVolume', Unit=unit, VolumeValue=value)
        s = m.create_entity('IfcElementQuantity', GlobalId=ifcopenshell.guid.new(), Name='Qto_WallBaseQuantities', Quantities=[q])
        return m.create_entity('IfcRelDefinesByProperties', GlobalId=ifcopenshell.guid.new(), RelatedObjects=[wall], RelatingPropertyDefinition=s)
    relation = assign(None, 12)
    assert explicit_quantities(wall, m)['NetVolume']['value'] == 12
    m.remove(relation)
    assign(mm3, 12e9)
    assert explicit_quantities(wall, m)['NetVolume']['value'] == pytest.approx(12)


def test_resource_bottleneck_quantity_and_crew_size_change_duration():
    q = quantity(12, 'm3', 'derived', 'test')
    demands = {'concrete_crew': 1, 'concrete_pump': 1, 'mixer': 1, 'vibrator': 1}
    base = production_profile()
    assert calculate_duration(q, 'concreting', demands, base)[0] == 120  # crew 6, pump12, mixer8, vibrator8
    assert calculate_duration({**q, 'value': 24}, 'concreting', demands, base)[0] == 240
    more_people = production_profile({'crew_people': {'concrete_crew': 4}})
    assert calculate_duration(q, 'concreting', demands, more_people)[0] == 90  # mixer/vibrator limit remains8
    slow_pump = production_profile({'rates': {'concreting': {'concrete_crew': 6, 'concrete_pump': 2, 'mixer': 8, 'vibrator': 8}}})
    assert calculate_duration(q, 'concreting', demands, slow_pump)[0] == 360
    with pytest.raises(ValueError, match='Единица'):
        calculate_duration({**q, 'unit': 'm2'}, 'concreting', demands, base)
    for bad in (0, -1, float('nan'), True):
        with pytest.raises(ValueError):
            production_profile({'rates': {'assembly': {'crew': bad}}})


def test_partial_assembly_does_not_fabricate_volume():
    v, f = cube()
    parts = [{'id': '101', 'measured_quantities': mesh_quantities(v, f)}, {'id': '707', 'measured_quantities': {}}]
    q = unit_quantities(parts, 'IfcStair', True)
    assert q['volume']['kind'] == 'unavailable' and q['volume']['value'] == 0
    assert q['count']['value'] == 2


def test_opening_uses_ifc_area_or_vertical_surface_and_steel_uses_mass():
    v, f = cube((1, .1, 2))
    part = {'id': 'any', 'measured_quantities': mesh_quantities(v, f)}
    q = unit_quantities([part], 'IfcDoor', True)
    assert q['area']['value'] == pytest.approx(2.2)  # vertical-face proxy, not .1m2 footprint
    part['quantities'] = {'Area': quantity(2, 'm2', 'explicit', 'ifc_base_quantity')}
    assert unit_quantities([part], 'IfcDoor', True)['area']['value'] == 2
    q = unit_quantities([part], 'IfcBeam', True)
    work = work_for({'quantities': q}, 'lifting', production_profile())
    assert work['unit'] == 't' and work['value'] == pytest.approx(.2 * 7.85)
    q['mass'] = quantity(500, 'kg', 'explicit', 'ifc_base_quantity')
    assert work_for({'quantities': q}, 'lifting', production_profile())['value'] == .5


def test_zero_cycle_gates_foundations_and_is_not_invented_for_floor_only():
    v, f = cube((4, 3, .3), (50, -90, -1))
    row = {'id': '987', 'step_id': 987, 'class': 'IfcFooting', 'hierarchy': ['IfcFooting'], 'name': 'arbitrary',
        'materials': ['Concrete - Cast In Situ'], 'property_sets': {}, 'role': 'element', 'storey_id': None,
        'mesh': {'bbox_min_m': v.min(axis=0).tolist(), 'bbox_max_m': v.max(axis=0).tolist()}, 'measured_quantities': mesh_quantities(v, f)}
    model = {'model_id': 'no-project-name', 'elements': [row], 'relationships': []}
    scenario = build_scenario(model)
    run = SimulationEngine(scenario).run()
    assert run['operation_states']['987:delivery']['start'] >= run['operation_states']['site:blinding_readiness']['finish']
    assert run['operation_states']['site:waterproofing']['start'] >= run['operation_states']['987:stripping']['finish']
    assert scenario['work_packages'][0]['excavation_quantity']['value'] == 33
    assert next(o for o in scenario['operations'] if o['id'] == '987:formwork')['work_quantity']['value'] == pytest.approx(4.2)
    pour = next(o for o in scenario['operations'] if o['kind'] == 'concreting')
    assert set(pour['demands']) == {'concrete_crew', 'concrete_pump', 'mixer', 'vibrator'}
    variant = build_scenario(model, 'reinforced')
    assert {o['id']: o['duration'] for o in scenario['operations']} == {o['id']: o['duration'] for o in variant['operations']}
    no_foundation = deepcopy(model)
    no_foundation['elements'][0].update({'class': 'IfcSlab', 'hierarchy': ['IfcSlab']})
    no_foundation['elements'][0]['materials'] = []
    other = build_scenario(no_foundation)
    assert 'site:excavation' not in {o['id'] for o in other['operations']}
    assert other['work_packages'][0]['status'] == 'requires_input'
