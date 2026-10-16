"""Kernel acceptance: resources, virtual time, deterministic replay, snapshots and DAGs."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from uvyazka.construction.simulation import SimulationEngine
from uvyazka.construction.planner import build_scenario


def scenario(capacity=1):
    return {"model_id": "no-geometry-required", "seed": 42,
        "resources": [{"id": "crew", "capacity": capacity}],
        "operations": [{"id": key, "name": key, "kind": "assembly", "duration": 10,
                        "demands": {"crew": 1}, "dependencies": [], "priority": 0} for key in ("A", "B")]}


def test_resources_create_real_waits_and_scenarios_change_duration():
    one = SimulationEngine(scenario()).run()
    two = SimulationEngine(scenario(2)).run()
    assert one["duration"] == 20
    assert two["duration"] == 10
    assert any(event["kind"] == "resource_wait" for event in one["events"])
    assert one["operation_states"]["B"]["start"] == 10
    assert all(event.get("used", 0) <= 1 for event in one["events"])


def test_virtual_time_step_size_and_pauses_do_not_change_result():
    fast = SimulationEngine(scenario()).run()
    slow = SimulationEngine(scenario())
    for tick in range(21):
        slow.advance_to(tick)
        before = slow.snapshot()
        slow.advance_to(tick)  # A pause cannot cause another event or consume resources.
        assert slow.snapshot() == before
    assert slow.events == fast["events"]
    assert slow.state()["resources_used"] == {"crew": 0}
    assert slow.run()["operation_states"] == fast["operation_states"]
    slow.advance_to(100)
    assert slow.run()["duration"] == fast["duration"]


def test_snapshot_restoration_and_repeat_reproduce_event_history():
    source = scenario()
    engine = SimulationEngine(source)
    engine.advance_to(7)
    snapshot = json.loads(json.dumps(engine.snapshot()))
    restored = SimulationEngine.restore(source, snapshot).run()
    repeated = SimulationEngine(source).run()
    assert restored == repeated
    with pytest.raises(ValueError, match="другой версии"):
        SimulationEngine.restore(scenario(2), snapshot)


def test_cycles_and_impossible_resources_fail_explicitly():
    cyclic = scenario()
    cyclic["operations"][0]["dependencies"] = ["B"]
    cyclic["operations"][1]["dependencies"] = ["A"]
    with pytest.raises(ValueError, match="Цикл"):
        SimulationEngine(cyclic)
    impossible = scenario()
    impossible["operations"][0]["demands"]["crew"] = 2
    with pytest.raises(ValueError, match="Неисполнимый"):
        SimulationEngine(impossible)


