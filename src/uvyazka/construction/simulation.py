"""Deterministic discrete-event construction kernel. No IFC, NumPy, HTTP or rendering."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import heapq
import json

ENGINE_VERSION = "0.1.0"


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def validate_scenario(scenario):
    operations = {operation["id"]: operation for operation in scenario["operations"]}
    resources = {resource["id"]: resource for resource in scenario["resources"]}
    if len(operations) != len(scenario["operations"]):
        raise ValueError("Повторяющиеся идентификаторы операций")
    if len(resources) != len(scenario["resources"]):
        raise ValueError("Повторяющиеся идентификаторы ресурсов")
    if any(not isinstance(resource["capacity"], int) or resource["capacity"] < 1 for resource in resources.values()):
        raise ValueError("Вместимость ресурса должна быть положительным целым числом")
    successors = {key: [] for key in operations}
    indegrees = {key: 0 for key in operations}
    for operation in operations.values():
        if not isinstance(operation["duration"], int) or operation["duration"] < 1:
            raise ValueError(f"Неположительная целочисленная длительность: {operation['id']}")
        for dependency in operation["dependencies"]:
            if dependency not in operations:
                raise ValueError(f"Не найден предшественник {dependency} для {operation['id']}")
            successors[dependency].append(operation["id"])
            indegrees[operation["id"]] += 1
        for resource_id, amount in operation.get("demands", {}).items():
            if resource_id not in resources or not isinstance(amount, int) or not 0 < amount <= resources[resource_id]["capacity"]:
                raise ValueError(f"Неисполнимый запрос ресурса {resource_id} в {operation['id']}")
    ready = sorted(key for key, degree in indegrees.items() if not degree)
    count = 0
    while ready:
        current = ready.pop()
        count += 1
        for child in successors[current]:
            indegrees[child] -= 1
            if not indegrees[child]:
                ready.append(child)
    if count != len(operations):
        blocked = sorted(key for key, degree in indegrees.items() if degree)
        raise ValueError(f"Цикл зависимостей; затронутые операции: {', '.join(blocked[:15])}")


class SimulationEngine:
    """Integer ticks are virtual minutes. All decisions occur at discrete events."""
    def __init__(self, scenario):
        validate_scenario(scenario)
        self.scenario = deepcopy(scenario)
        self.manifest = {"engine_version": ENGINE_VERSION, "scenario_sha256": canonical_hash(scenario),
            "model_id": scenario["model_id"], "seed": scenario.get("seed", 0), "tick_unit": "minute"}
        self.run_id = canonical_hash(self.manifest)
        self.operations = {operation["id"]: operation for operation in self.scenario["operations"]}
        self.resources = {resource["id"]: resource for resource in self.scenario["resources"]}
        self.states = {key: {"status": "pending", "start": None, "finish": None, "waiting_for": []} for key in self.operations}
        self.used = {key: 0 for key in self.resources}
        self.time = 0
        self.events = []
        self.queue = []
        self.next_sequence = 0
        self.dispatch_times = set()
        self._dispatch_at(0)

    def _schedule(self, tick, priority, kind, operation_id=None):
        self.next_sequence += 1
        heapq.heappush(self.queue, (tick, priority, self.next_sequence, kind, operation_id))

    def _dispatch_at(self, tick):
        if tick not in self.dispatch_times:
            self.dispatch_times.add(tick)
            self._schedule(tick, 10, "dispatch")

    def _emit(self, kind, operation_id=None, **data):
        self.events.append({"sequence": len(self.events), "time": self.time,
            "kind": kind, "operation_id": operation_id, **data})

    def step(self):
        if not self.queue:
            return False
        self.time, _, sequence, kind, operation_id = heapq.heappop(self.queue)
        if kind == "finish":
            operation = self.operations[operation_id]
            state = self.states[operation_id]
            state.update(status="completed", finish=self.time, waiting_for=[])
            for resource_id, amount in sorted(operation.get("demands", {}).items()):
                self.used[resource_id] -= amount
                self._emit("resource_released", operation_id, resource_id=resource_id, amount=amount, used=self.used[resource_id], cause=sequence)
            self._emit("operation_completed", operation_id, cause=sequence)
            if operation["kind"] == "delivery":
                self._emit("material_delivered", operation_id, target_ids=operation.get("target_ids", []), cause=sequence)
            if operation["kind"] == "inspection":
                self._emit("quality_gate_passed", operation_id, synthetic=True, cause=sequence)
            self._dispatch_at(self.time)
        elif kind == "dispatch":
            self.dispatch_times.remove(self.time)
            candidates = sorted(self.operations.values(), key=lambda operation: (operation.get("priority", 0), operation["id"]))
            for operation in candidates:
                state = self.states[operation["id"]]
                if state["status"] not in ("pending", "waiting", "ready"):
                    continue
                if any(self.states[parent]["status"] != "completed" for parent in operation["dependencies"]):
                    continue
                if state["status"] == "pending":
                    state["status"] = "ready"
                    self._emit("operation_ready", operation["id"], cause=sequence)
                unavailable = [resource_id for resource_id, amount in sorted(operation.get("demands", {}).items()) if self.used[resource_id] + amount > self.resources[resource_id]["capacity"]]
                if unavailable:
                    if state["status"] != "waiting" or state["waiting_for"] != unavailable:
                        self._emit("resource_wait", operation["id"], resource_ids=unavailable, cause=sequence)
                    state.update(status="waiting", waiting_for=unavailable)
                    continue
                state.update(status="running", start=self.time, waiting_for=[])
                for resource_id, amount in sorted(operation.get("demands", {}).items()):
                    self.used[resource_id] += amount
                    self._emit("resource_acquired", operation["id"], resource_id=resource_id, amount=amount, used=self.used[resource_id], cause=sequence)
                self._emit("operation_started", operation["id"], duration=operation["duration"], cause=sequence)
                self._schedule(self.time + operation["duration"], 0, "finish", operation["id"])
        return True

    def advance_to(self, tick):
        if not isinstance(tick, int) or tick < self.time:
            raise ValueError("Для перемотки назад восстановите снимок или создайте повтор запуска")
        while self.queue and self.queue[0][0] <= tick:
            self.step()
        self.time = tick
        return self.state()

    def run(self):
        while self.step():
            pass
        unfinished = [key for key, state in self.states.items() if state["status"] != "completed"]
        if unfinished:
            self._emit("run_blocked", operation_ids=unfinished)
        return {"contract": "RunPackage", "contract_version": "0.1.0", "run_id": self.run_id,
            "manifest": self.manifest, "scenario": self.scenario, "events": self.events,
            "operation_states": self.states, "duration": max((state["finish"] or 0 for state in self.states.values()), default=0) if not unfinished else self.time,
            "status": "blocked" if unfinished else "completed"}

    def state(self):
        return {"time": self.time, "operations": deepcopy(self.states), "resources_used": dict(self.used)}

    def snapshot(self):
        return {"manifest": deepcopy(self.manifest), "time": self.time, "states": deepcopy(self.states),
            "used": dict(self.used), "queue": deepcopy(self.queue), "events": deepcopy(self.events),
            "next_sequence": self.next_sequence, "dispatch_times": sorted(self.dispatch_times)}

    @classmethod
    def restore(cls, scenario, snapshot):
        engine = cls(scenario)
        if engine.manifest != snapshot["manifest"]:
            raise ValueError("Снимок относится к другой версии сценария или движка")
        engine.time = snapshot["time"]
        engine.states = deepcopy(snapshot["states"])
        engine.used = dict(snapshot["used"])
        engine.queue = [tuple(event) for event in snapshot["queue"]]
        heapq.heapify(engine.queue)
        engine.events = deepcopy(snapshot["events"])
        engine.next_sequence = snapshot["next_sequence"]
        engine.dispatch_times = set(snapshot["dispatch_times"])
        return engine
