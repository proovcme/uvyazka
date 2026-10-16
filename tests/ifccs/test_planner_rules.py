"""General rules exercised on synthetic IFC contracts and both unmodified files."""
import json
from pathlib import Path

import pytest

from uvyazka.construction.importer import import_model
from uvyazka.construction.planner import build_scenario
from uvyazka.construction.simulation import SimulationEngine


def element(key, family, lower, upper, *, materials=(), predefined_type=None, common=None, subtype=None, mesh=True):
    return {"id": str(key), "step_id": key, "class": subtype or family,
        "hierarchy": [subtype, family] if subtype else [family], "name": "arbitrary name",
        "role": "element", "storey_id": None, "materials": list(materials), "predefined_type": predefined_type,
        "property_sets": {"Pset_WallCommon": common or {}},
        "mesh": {"bbox_min_m": lower, "bbox_max_m": upper} if mesh else None}


def model(elements, relationships=()):
    return {"model_id": "synthetic-without-project-identifiers", "elements": elements, "relationships": list(relationships)}


@pytest.mark.parametrize("material", ["", "Custom material Ω", "Материал без классификации", "材料"])
def test_unknown_wall_does_not_become_finish_or_confirmed_technology(material):
    unit = build_scenario(model([element(8, "IfcWall", [0, 0, 0], [4, .2, 3], materials=[material])]))["units"][0]
    assert unit["kind"] == "generic"
    assert unit["technology_status"] == "unresolved"
    assert unit["construction_role"] == "structure"


def test_partition_needs_positive_evidence_and_opening_material_does_not_override_class():
    rows = [
        element(1, "IfcWall", [0, 0, 0], [4, .2, 3], common={"IsExternal": False, "LoadBearing": False}),
        element(2, "IfcWall", [0, 1, 0], [4, 1.2, 3], materials=["Plasterboard"], common={"IsExternal": False, "LoadBearing": False}),
        element(3, "IfcWall", [0, 2, 0], [4, 2.2, 3], materials=["Plasterboard"], common={"IsExternal": True, "LoadBearing": False}),
        element(4, "IfcWall", [0, 3, 0], [4, 3.2, 3], predefined_type="PARTITIONING", common={"LoadBearing": True}),
        element(5, "IfcWall", [0, 4, 0], [4, 4.2, 3], predefined_type="PARTITIONING"),
        element(6, "IfcDoor", [0, 0, 0], [1, .1, 2], materials=["Wood"]),
    ]
    units = {u["id"]: u for u in build_scenario(model(rows))["units"]}
    assert {key for key, unit in units.items() if unit["kind"] == "finish"} == {"2", "5"}
    assert units["6"]["kind"] == "opening"


@pytest.mark.parametrize("offset,renumber,roof_family", [(0, 0, "IfcSlab"), (97.3, 1000, "IfcRoof")])
def test_gables_and_members_finish_before_roof_without_cycles_or_project_names(offset, renumber, roof_family):
    def row(key, family, lower, upper, **options):
        return element(key + renumber, family, [lower[0] + offset, lower[1] - offset, lower[2]],
                       [upper[0] + offset, upper[1] - offset, upper[2]], **options)
    rows = [row(90, "IfcSlab", [0, 0, -.2], [10, 8, 0], predefined_type="FLOOR"),
        row(80, "IfcWall", [0, 0, 0], [10, .2, 3]),
        row(70, "IfcWall", [0, 7.8, 3], [10, 8, 7]),  # Gable top exceeds roof eaves.
        row(20, "IfcMember", [1, 0, 3.1], [1.2, 8, 7], subtype="IfcMemberStandardCase"),
        row(10, roof_family, [-.2, -.2, 3.1], [10.2, 8.2, 7.2], predefined_type="ROOF")]
    scenario = build_scenario(model(rows)); run = SimulationEngine(scenario).run()
    assert run["status"] == "completed"
    units = {u["id"]: u for u in scenario["units"]}
    roof = units[str(10 + renumber)]
    roof_start = run["operation_states"][roof["operation_ids"][0]]["start"]
    for key in (80, 70, 20):
        before = units[str(key + renumber)]
        assert run["operation_states"][before["operation_ids"][-1]]["finish"] <= roof_start
    assert units[str(20 + renumber)]["family"] == "IfcMember"
    assert units[str(20 + renumber)]["kind"] == "generic"  # No invented steel / timber.
    assert len({key for u in scenario["units"] for key in u["target_ids"]}) == 5


def test_stair_members_are_not_scheduled_twice_and_floor_beams_still_precede_floor():
    rows = [element(1, "IfcStair", [0, 0, 0], [2, 3, 3], mesh=False),
        element(2, "IfcMember", [0, 0, 0], [.2, 3, 3], predefined_type="STRINGER"),
        element(3, "IfcBeam", [4, 0, 2.5], [4.2, 8, 2.8]),
        element(4, "IfcSlab", [3, 0, 2.8], [8, 8, 3], predefined_type="FLOOR"),
        element(5, "IfcSlab", [3, 0, 2.8], [8, 8, 6], predefined_type="ROOF")]
    relationships = [{"class": "IfcRelAggregates", "parent_id": "1", "child_ids": ["2"]}]
    scenario = build_scenario(model(rows, relationships)); result = SimulationEngine(scenario).run()
    units = {u["id"]: u for u in scenario["units"]}
    assert "2" not in units and units["1"]["target_ids"] == ["2"]
    assert units["3"]["construction_role"] == "structure"
    assert result["operation_states"][units["3"]["operation_ids"][-1]]["finish"] <= result["operation_states"][units["4"]["operation_ids"][0]]["start"]


def test_wall_above_roof_beam_cannot_become_a_predecessor_of_its_own_support():
    rows = [element(11, "IfcBeam", [0, 0, 5.7], [8, .2, 6], materials=["Steel"]),
        element(12, "IfcWall", [0, 0, 6], [8, .2, 6.7], common={"IsExternal": True}),
        element(13, "IfcSlab", [0, 0, 6], [8, 6, 6.4], predefined_type="ROOF")]
    scenario = build_scenario(model(rows)); run = SimulationEngine(scenario).run()
    units = {unit["id"]: unit for unit in scenario["units"]}
    finish = lambda key: run["operation_states"][units[key]["operation_ids"][-1]]["finish"]
    start = lambda key: run["operation_states"][units[key]["operation_ids"][0]]["start"]
    assert finish("11") <= start("12")
    assert finish("12") <= start("13")


@pytest.mark.parametrize("seed", [1, 42, 109])
def test_concrete_wait_is_calendar_time_and_gates_strip_and_supported_work(seed):
    rows = [element(31, "IfcFooting", [0, 0, -1], [5, 1, 0], materials=["Concrete - Cast In Situ"]),
            element(32, "IfcWall", [0, 0, 0], [5, .2, 3])]
    scenario = build_scenario(model(rows), seed=seed)
    run = SimulationEngine(scenario).run()
    operations = {operation['id']: operation for operation in scenario['operations']}
    state = run['operation_states']
    assert operations['31:curing']['duration'] == 28 * 1440
    assert not operations['31:curing']['demands']
    assert state['31:curing']['start'] == state['31:concreting']['finish']
    assert state['31:curing']['finish'] - state['31:concreting']['finish'] == 28 * 1440
    assert state['31:strength_check']['start'] >= state['31:curing']['finish']
    assert state['31:stripping']['start'] >= state['31:strength_check']['finish']
    assert state['32:delivery']['start'] >= state['31:stripping']['finish']
    assert scenario['concrete_readiness_policy']['required_strength_mpa'] is None
    gate = next(event for event in run['events'] if event['kind'] == 'concrete_readiness_assumed')
    assert gate['synthetic'] is True and gate['strength_verified'] is False
    assert gate['concrete_readiness']['measured_strength_mpa'] is None
    engine = SimulationEngine(scenario)
    engine.advance_to(state['31:concreting']['finish'] + 1440)
    assert engine.state()['operations']['31:curing']['status'] == 'running'
    assert engine.state()['operations']['31:stripping']['status'] == 'pending'
    assert SimulationEngine.restore(scenario, engine.snapshot()).run() == run


def test_concrete_hold_is_a_scenario_parameter_not_changed_by_resource_count():
    source = model([element(41, 'IfcSlab', [0, 0, 0], [4, 4, .2], materials=['Concrete - Cast In Situ'])])
    for variant in ('base', 'reinforced'):
        scenario = build_scenario(source, variant, concrete_curing_days=35)
        assert next(o for o in scenario['operations'] if o['kind'] == 'curing')['duration'] == 35 * 1440
    assert SimulationEngine(build_scenario(source, concrete_curing_days=35)).run_id != SimulationEngine(build_scenario(source)).run_id
    for invalid in (0, -1, True, 1.5, '28', 366):
        with pytest.raises(ValueError, match='календарных суток'):
            build_scenario(source, concrete_curing_days=invalid)
