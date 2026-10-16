"""Experimental geometry must never silently become a construction takeoff."""
import json
from pathlib import Path
from copy import deepcopy

import pytest

from uvyazka.construction.importer import geometry_evidence
from uvyazka.construction.quantities import quantity, unit_quantities
from uvyazka.construction.rvt import validate_input, import_source, OLE_SIGNATURE, normalize_rvt_ifc
from uvyazka.construction.authoring import DrawingProjects


@pytest.mark.parametrize('body', ['partition_element_record_bbox', 'partition_family_instance_turned_box',
    'partition_family_instance_oriented_box', 'new_unreviewed_source', None])
def test_boxes_and_unknown_sources_cannot_supply_work_quantities(body):
    evidence = geometry_evidence({'RvtElementRecordGeometry': {'BodySource': body}}, 'rvt-rs 0.4.0')
    assert evidence['quantity_eligible'] is False
    part = {'id': '1', 'geometry_evidence': evidence,
        'quantities': {'NetVolume': quantity(999, 'm3', 'explicit', 'exported_qto')},
        'measured_quantities': {'volume': quantity(888, 'm3', 'derived', 'closed_box'),
            'plan_area': quantity(777, 'm2', 'derived', 'box_projection')}}
    result = unit_quantities([part], 'IfcSlab', True)
    assert all(result[name]['kind'] == 'unavailable' for name in ('volume', 'area', 'mass', 'formwork_area'))
    assert result['count']['value'] == 1


def test_mixed_assembly_cannot_present_partial_quantities_as_a_total():
    body = {'id': '1', 'measured_quantities': {'volume': quantity(2, 'm3', 'derived', 'mesh')}}
    box = {**deepcopy(body), 'id': '2', 'geometry_evidence': {'quantity_eligible': False}}
    result = unit_quantities([body, box], 'IfcWall', True)
    assert result['volume']['kind'] == 'unavailable'
    assert result['volume']['value'] == 0
    assert result['count']['value'] == 2


def test_normal_ifc_quantities_unchanged_and_decoded_bodies_keep_evidence():
    assert geometry_evidence({}, 'Revit IFC exporter') is None
    assert geometry_evidence({}, 'rvt-rs 0.4.0')['quantity_eligible'] is False
    evidence = geometry_evidence({'RvtElementRecordGeometry': {'BodySource': 'saved_graphics_mesh'}}, 'rvt-rs')
    part = {'id': '1', 'geometry_evidence': evidence,
        'measured_quantities': {'volume': quantity(3, 'm3', 'derived', 'closed_mesh')}}
    q = unit_quantities([part], 'IfcWall', True)['volume']
    assert q['value'] == 3
    assert q['components'][0]['geometry_evidence']['requires_review'] is True
    resolved = geometry_evidence({'RvtElementRecordGeometry': {
        'BodySource': 'partition_element_record_bbox', 'ProfileResolved': True}}, 'rvt-rs')
    assert resolved['quantity_eligible'] is True


def test_rvt_intake_checks_signature_and_read_roots(workspace_temp):
    directory = workspace_temp / 'rvt-boundaries'
    directory.mkdir()
    source = directory / 'bad.rvt'
    source.write_bytes(b'not a Revit file')
    with pytest.raises(ValueError, match='OLE/CFB'):
        validate_input(source, source.name)
    store = DrawingProjects(directory / 'cache', [directory / 'allowed'])
    with pytest.raises(ValueError, match='корней'):
        store.import_rvt(source.name, path=str(source))


def test_unsupported_version_does_not_publish_an_empty_model(workspace_temp, monkeypatch):
    directory = workspace_temp / 'rvt-version'
    directory.mkdir()
    source = directory / 'old.rvt'
    source.write_bytes(OLE_SIGNATURE + b'fixture')
    monkeypatch.setattr('uvyazka.construction.rvt.inspect_rvt', lambda p: {'version': 2021})
    monkeypatch.setattr('uvyazka.construction.rvt.import_identity', lambda p, n: 'a' * 64)
    target = directory / 'package'
    with pytest.raises(ValueError, match='Revit 2021'):
        import_source(source, target)
    assert not (target / 'manifest.json').exists()
    assert not (target / 'converted.ifc').exists()


def test_normalizer_preserves_products_and_geometry_and_is_idempotent(workspace_temp):
    import ifcopenshell
    model = ifcopenshell.file(schema='IFC4')
    storey = model.create_entity('IfcBuildingStorey', GlobalId=ifcopenshell.guid.new(), Name='Level')
    room = model.create_entity('IfcSpace', GlobalId=ifcopenshell.guid.new(), Name='Room')
    wall = model.create_entity('IfcWall', GlobalId=ifcopenshell.guid.new(), Name='Wall')
    relation = model.create_entity('IfcRelContainedInSpatialStructure', GlobalId=ifcopenshell.guid.new(),
        RelatingStructure=storey, RelatedElements=[room, wall])
    product_ids = {item.GlobalId: item.id() for item in model.by_type('IfcProduct')}
    target = workspace_temp / 'spatial-normalization.ifc'
    model.write(str(target))
    changes = normalize_rvt_ifc(target)
    assert len(changes) == 1
    normalized = ifcopenshell.open(str(target))
    assert {item.GlobalId: item.id() for item in normalized.by_type('IfcProduct')} == product_ids
    assert len(normalized.by_type('IfcRelAggregates')) == 1
    assert [item.id() for item in normalized.by_id(relation.id()).RelatedElements] == [wall.id()]
    room_after = normalized.by_id(room.id())
    assert room_after.Decomposes[0].RelatingObject.id() == storey.id()
    before = target.read_bytes()
    assert normalize_rvt_ifc(target) == []
    assert target.read_bytes() == before
