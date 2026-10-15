"""Explainable provisional construction scenarios, independent of the 3D renderer.

Every technology and duration is a simulation assumption, not a construction approval.
"""
from __future__ import annotations

from collections import defaultdict
import random

from .simulation import validate_scenario

PLANNER_VERSION = "0.1.0"
FAMILIES = ("IfcFooting", "IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcStair", "IfcRoof", "IfcDoor", "IfcWindow")


def build_scenario(model, variant="base", seed=42):
    if variant not in ("base", "reinforced"):
        raise ValueError("Неизвестный сценарий")
    randomizer = random.Random(seed)
    elements = {element["id"]: element for element in model["elements"]}
    children, aggregate_parent, opening_owner, filling_host = defaultdict(list), {}, {}, {}
    for relation in model["relationships"]:
        if relation["class"] in ("IfcRelAggregates", "IfcRelNests"):
            children[relation["parent_id"]].extend(relation["child_ids"])
            for child in relation["child_ids"]:
                aggregate_parent[child] = relation["parent_id"]
        if relation["class"] == "IfcRelVoidsElement":
            for child in relation["child_ids"]:
                opening_owner[child] = relation["parent_id"]
    for relation in model["relationships"]:
        if relation["class"] == "IfcRelFillsElement":
            for child in relation["child_ids"]:
                if relation["parent_id"] in opening_owner:
                    filling_host[child] = opening_owner[relation["parent_id"]]

    def leaves(key, visited=None):
        visited = set() if visited is None else visited
        if key in visited:
            raise ValueError(f"Циклический состав IFC у #{key}")
        visited.add(key)
        result = []
        element = elements.get(key)
        if element and element["mesh"] and element["role"] == "element":
            result.append(element)
        for child in children.get(key, []):
            result.extend(leaves(child, visited.copy()))
        return result

    units, claimed = [], set()
    candidates = sorted(elements.values(), key=lambda element: (0 if element["class"] in ("IfcStair", "IfcRoof") else 1, element["step_id"]))
    for element in candidates:
        family = next((family for family in FAMILIES if family in element["hierarchy"]), None)
        if not family or element["id"] in claimed:
            continue
        parts = [part for part in leaves(element["id"]) if part["id"] not in claimed]
        if not parts:
            continue
        claimed.update(part["id"] for part in parts)
        lower = [min(part["mesh"]["bbox_min_m"][axis] for part in parts) for axis in range(3)]
        upper = [max(part["mesh"]["bbox_max_m"][axis] for part in parts) for axis in range(3)]
        materials = set(element["materials"] + [name for part in parts for name in part["materials"]])
        material_text = " ".join(materials).lower()
        finish = family == "IfcSlab" and any(value in material_text for value in ("flooring", "ceramic tile"))
        interior = family == "IfcWall" and "masonry" not in material_text and "concrete" not in material_text
        kind = ("finish" if finish or interior else "concrete" if "cast in situ" in material_text else
                "masonry" if "masonry" in material_text else "steel" if "steel" in material_text else
                "timber" if "wood" in material_text else "opening" if family in ("IfcDoor", "IfcWindow") else "generic")
        plane = upper[2] if family in ("IfcBeam", "IfcStair") else lower[2] if family == "IfcRoof" else upper[2] if family == "IfcSlab" and not finish else lower[2]
        plane = round(plane, 5)  # Ignore tessellation noise when ordering work on one elevation.
        phase = 0 if family in ("IfcFooting", "IfcBeam") else 1 if family in ("IfcSlab", "IfcRoof") else 2 if family in ("IfcWall", "IfcColumn") else 4
        units.append({"id": element["id"], "name": element["name"], "class": element["class"], "family": family,
            "target_ids": [part["id"] for part in parts], "kind": kind, "lower": lower, "upper": upper,
            "plane": plane, "phase": phase, "materials": sorted(materials), "storey_id": element["storey_id"],
            "technology_status": "assumed", "evidence": {"source_element_id": element["id"],
                "kind": "assumed", "rule": f"provisional_{kind}", "rule_version": PLANNER_VERSION,
                "reason": "Предварительная технология по классу и материалам IFC; ПОС/ППР и способ изготовления не заданы"}})
    units.sort(key=lambda unit: (unit["kind"] == "finish", unit["plane"], unit["phase"], int(unit["id"])))
    unit_by_element = {key: unit for unit in units for key in [unit["id"], *unit["target_ids"]]}
    operations = [{"id": "site:prepare", "name": "Подготовка рабочей площадки", "kind": "preparation", "target_ids": [],
        "duration": 60, "demands": {"crew": 1}, "dependencies": [], "priority": 0, "visual_phase": "none",
        "evidence": {"kind": "assumed", "basis": "simulation_assumption", "reason": "Подготовительная операция отсутствует в IFC"}}]
    edges, unit_ops = [], {}
    templates = {
        "concrete": [("delivery", "Доставка материалов", 20, {"truck": 1}, "none"), ("reinforcement", "Армирование", 75, {"crew": 1}, "work"),
            ("formwork", "Монтаж опалубки", 60, {"crew": 1}, "work"), ("inspection", "Контроль перед бетонированием", 15, {"inspector": 1}, "none"),
            ("concreting", "Бетонирование", 40, {"concrete_crew": 1}, "work"), ("curing", "Условное выдерживание", 480, {}, "work"),
            ("stripping", "Распалубка", 30, {"crew": 1}, "work")],
        "masonry": [("delivery", "Доставка кладочных материалов", 20, {"truck": 1}, "none"), ("masonry", "Кладка и устройство слоёв стены", 100, {"crew": 1}, "work")],
        "steel": [("delivery", "Доставка стального элемента", 20, {"truck": 1}, "none"), ("lifting", "Монтаж стального элемента", 45, {"crane": 1, "crew": 1}, "work")],
        "timber": [("delivery", "Доставка деревянных элементов", 20, {"truck": 1}, "none"), ("assembly", "Сборка деревянной конструкции", 80, {"crew": 1}, "work")],
        "finish": [("finishing", "Устройство перегородки или слоёв отделки", 55, {"crew": 1}, "work")],
        "opening": [("installation", "Установка заполнения проёма", 35, {"crew": 1}, "work")],
        "generic": [("delivery", "Доставка — условный состав", 20, {"truck": 1}, "none"), ("assembly", "Устройство элемента — технология требует уточнения", 75, {"crew": 1}, "work")],
    }
    for unit_index, unit in enumerate(units):
        previous = None
        unit_ops[unit["id"]] = []
        for phase_index, (kind, name, duration, demands, visual) in enumerate(templates[unit["kind"]]):
            operation_id = f"{unit['id']}:{kind}"
            dependencies = [previous] if previous else ["site:prepare"]
            if previous:
                edges.append({"before": previous, "after": operation_id, "kind": "technology", "evidence": unit["evidence"]})
            operation = {"id": operation_id, "unit_id": unit["id"], "name": name, "kind": kind,
                "target_ids": unit["target_ids"], "duration": max(1, round(duration * randomizer.uniform(0.9, 1.1))),
                "demands": demands, "dependencies": dependencies, "priority": unit_index * 10 + phase_index + 1,
                "visual_phase": visual, "evidence": {**unit["evidence"], "basis": "simulation_assumption",
                    "duration_note": "Условные минуты для демонстрации; не норматив и не производительность"}}
            operations.append(operation)
            unit_ops[unit["id"]].append(operation_id)
            previous = operation_id
        unit["operation_ids"] = unit_ops[unit["id"]]
    operation_by_id = {operation["id"]: operation for operation in operations}

    def link(before, after, rule, evidence_kind="assumed"):
        if before["id"] == after["id"]:
            return
        source, target = unit_ops[before["id"]][-1], unit_ops[after["id"]][0]
        if source not in operation_by_id[target]["dependencies"]:
            operation_by_id[target]["dependencies"].append(source)
            edges.append({"before": source, "after": target, "kind": rule,
                "evidence": {"kind": evidence_kind, "rule_version": PLANNER_VERSION,
                    "source_element_ids": [before["id"], after["id"]],
                    "reason": "Связь хозяина проёма из IFC" if evidence_kind == "derived" else
                              "Консервативная последовательность по габаритам и виду работ; несущая способность не проверена"}})

    for unit in units:
        if unit["kind"] == "finish":
            for before in units:
                if before["kind"] not in ("finish", "opening"):
                    link(before, unit, "shell_before_finish")
            continue
        if unit["kind"] == "opening":
            host = unit_by_element.get(filling_host.get(unit["id"]))
            if host:
                link(host, unit, "ifc_host_before_filling", "derived")
            continue
        rank = (unit["plane"], unit["phase"], int(unit["id"]))
        candidates = []
        for before in units:
            if before["kind"] in ("finish", "opening") or (before["plane"], before["phase"], int(before["id"])) >= rank:
                continue
            overlap = all(min(before["upper"][axis], unit["upper"][axis]) - max(before["lower"][axis], unit["lower"][axis]) >= -0.03 for axis in (0, 1))
            near = abs(before["upper"][2] - unit["lower"][2]) < 0.5
            zone_barrier = unit["family"] in ("IfcSlab", "IfcRoof") and before["family"] == "IfcBeam" and abs(before["upper"][2] - unit["lower"][2]) < 0.5
            # AABB overlap is a candidate sequencing constraint, never a proof of structural support.
            if (overlap and (near or before["family"] == "IfcFooting")) or zone_barrier:
                candidates.append(before)
        if not candidates and unit["family"] != "IfcFooting":
            candidates = [before for before in units if before["family"] == "IfcFooting" and before["plane"] < unit["plane"]]
        for before in candidates:
            link(before, unit, "geometry_sequence_candidate")
    more = variant == "reinforced"
    resources = [{"id": key, "name": name, "capacity": capacity, "kind": "renewable"} for key, name, capacity in (
        ("crew", "Строительные бригады", 6 if more else 3), ("truck", "Доставка", 2 if more else 1),
        ("crane", "Краны", 2 if more else 1), ("concrete_crew", "Бетонирование", 2 if more else 1),
        ("inspector", "Условный контроль", 1))]
    scenario = {"contract": "ScenarioPackage", "contract_version": "0.1.0", "model_id": model["model_id"],
        "id": variant, "name": "Усиленные ресурсы" if more else "Базовые ресурсы", "seed": seed,
        "planner_version": PLANNER_VERSION, "operations": operations, "resources": resources,
        "dependencies": edges, "units": units, "unplanned_element_ids": [element["id"] for element in model["elements"] if element["role"] == "element" and element["id"] not in claimed],
        "assumptions": ["Все длительности условные, время непрерывное без смен и погоды", "Технологии предварительные; ПОС/ППР и несущая схема не подтверждены",
                        "Контрольные точки проходят синтетически, без подтверждения реальной приёмки", "Классы без технологии исключены из виртуального строительства и сохранены в модели"],
        "tick_unit": "minute"}
    validate_scenario(scenario)
    return scenario
