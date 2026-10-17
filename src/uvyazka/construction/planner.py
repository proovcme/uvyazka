"""Explainable provisional construction scenarios, independent of the 3D renderer.

Every technology and duration is a simulation assumption, not a construction approval.
"""
from __future__ import annotations

from collections import defaultdict
from .quantities import unit_quantities, quantity
from .production import production_profile, work_for, make_operation
from .packages import site_package

from .simulation import validate_scenario
from . import mep
from .phases import phase_context, phase_status
from .access import access_packages

PLANNER_VERSION = "0.5.0"
DEFAULT_CONCRETE_CURING_DAYS = 28
FAMILIES = ("IfcFooting", "IfcColumn", "IfcBeam", "IfcMember", "IfcSlab", "IfcWall", "IfcStair", "IfcRoof", "IfcDoor", "IfcWindow", *mep.MEP_FAMILIES)
ROOF_MEMBER_TYPES = {"PURLIN", "RAFTER", "COLLAR"}


def predefined(element):
    # Exporter names / ObjectType text are not interpreted as standard enum values.
    return str(element.get("predefined_type") or "").upper()


def classify_technology(element, family, materials):
    engineering = mep.technology(element, family)
    if engineering:
        return engineering[0], 'Предварительный монтаж по классу IFC; топология и технология испытаний не подтверждены'
    text = " ".join(materials).casefold()
    common = element.get("property_sets", {}).get("Pset_WallCommon", {})
    positive_partition = (predefined(element) == "PARTITIONING" or
        (common.get("LoadBearing") is False and common.get("IsExternal") is False and
         any(token in text for token in ("plasterboard", "gypsum board", "drywall"))))
    partition = family == "IfcWall" and common.get("LoadBearing") is not True and common.get("IsExternal") is not True and positive_partition
    floor_finish = family == "IfcSlab" and predefined(element) != "ROOF" and any(token in text for token in ("flooring", "ceramic tile"))
    if family in ("IfcDoor", "IfcWindow"):
        return "opening", "Класс IFC задаёт заполнение проёма независимо от материала"
    if partition or floor_finish:
        return "finish", "Положительный признак перегородки или отделочного слоя; отсутствие материала не используется как подтверждение"
    for kind, tokens in (("concrete", ("cast in situ",)), ("masonry", ("masonry",)),
                         ("steel", ("steel",)), ("timber", ("wood",))):
        if any(token in text for token in tokens):
            return kind, "Предварительный шаблон по явно распознанному материалу; способ изготовления не подтверждён"
    return "generic", "Материал или способ изготовления не распознан: технология не определена, показан условный общий монтаж"


def overlaps_xy(before, after, tolerance=.03):
    return all(min(before["upper"][axis], after["upper"][axis]) - max(before["lower"][axis], after["lower"][axis]) >= -tolerance for axis in (0, 1))


def assign_roles(units):
    for unit in units:
        unit["construction_role"] = ('mep' if unit['kind'].startswith('mep_') else 'demolition' if unit['kind'] == 'demolition' else "opening" if unit["kind"] == "opening" else "finish" if unit["kind"] == "finish" else
            "roof" if unit["family"] == "IfcRoof" or unit["family"] == "IfcSlab" and unit["predefined_type"] == "ROOF" else "structure")
    roofs = [unit for unit in units if unit["construction_role"] == "roof"]
    for unit in units:
        if unit["family"] not in ("IfcBeam", "IfcMember"):
            continue
        related = [roof for roof in roofs if overlaps_xy(unit, roof, .5) and
                   unit["upper"][2] >= roof["lower"][2] - .03 and unit["lower"][2] <= roof["upper"][2] + .03]
        # A beam directly below an ordinary floor remains part of that floor's
        # structure; moving it to a later roof stage would invert its support edge.
        if unit["family"] == "IfcBeam" and any(other["family"] == "IfcSlab" and other["construction_role"] == "structure" and
                overlaps_xy(unit, other) and abs(unit["upper"][2] - other["lower"][2]) < .5 for other in units):
            related = []
        if unit["family"] == "IfcMember" and unit["predefined_type"] in {"STRINGER", "MULLION", "STUD"}:
            related = []
        explicit = unit["family"] == "IfcMember" and unit["predefined_type"] in ROOF_MEMBER_TYPES
        if related or explicit:
            unit["construction_role"] = "roof_frame"
            unit["related_roof_ids"] = [roof["id"] for roof in related]
            unit["roof_role_basis"] = "ifc_predefined_type" if explicit else "assumed_geometry_candidate"


def sequence_key(unit):
    # Keep structural beams/members in elevation order: a beam may support a
    # higher wall/parapet. Only the roof covering is a later envelope stage.
    stage = {"demolition": -1, "structure": 0, "roof_frame": 0, "roof": 1, 'mep': 2, "finish": 3, "opening": 3}[unit["construction_role"]]
    prefix, _, numeric = unit['id'].rpartition(':')
    return stage, unit["plane"], unit["phase"], (prefix, int(numeric))


def build_scenario(model, variant="base", seed=42, concrete_curing_days=DEFAULT_CONCRETE_CURING_DAYS, production=None, phase_selections=None):
    if variant not in ("base", "reinforced"):
        raise ValueError("Неизвестный сценарий")
    if type(concrete_curing_days) is not int or not 1 <= concrete_curing_days <= 365:
        raise ValueError("Выдержка бетона задаётся целым числом календарных суток от 1 до 365")
    concrete_readiness = {"mode": "age_assumption", "curing_days": concrete_curing_days,
        "hold_minutes": concrete_curing_days * 1440, "basis": "simulation_assumption",
        "temperature_c": None, "required_strength_mpa": None, "measured_strength_mpa": None,
        "strength_verified": False, "purposes": ["stripping", "subsequent_loading"],
        "reason": "Срок сценария при отсутствии данных о составе, температуре, уходе и критериях ППР; календарный возраст не подтверждает прочность"}
    profile = production_profile(production)
    elements = {element["id"]: element for element in model["elements"]}
    contexts = phase_context(model, phase_selections)
    phases = {e['id']: phase_status(e, contexts) for e in model['elements']}
    initial = [key for key, state in phases.items() if state == 'existing' and elements[key]['role']=='element']
    excluded = [key for key, state in phases.items() if state in ('future', 'absent') and elements[key]['role']=='element']
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
        if element and element["mesh"] and element["role"] == "element" and element['id'] not in initial + excluded:
            result.append(element)
        for child in children.get(key, []):
            result.extend(leaves(child, visited.copy()))
        return result

    units, claimed = [], set()
    candidates = sorted(elements.values(), key=lambda element: (0 if any(family in element["hierarchy"] for family in ("IfcStair", "IfcRoof")) else 1, element["step_id"]))
    for element in candidates:
        family = next((family for family in FAMILIES if family in element["hierarchy"]), None)
        if not family or element["id"] in claimed or element['id'] in initial + excluded:
            continue
        parts = [part for part in leaves(element["id"]) if part["id"] not in claimed]
        if not parts:
            continue
        claimed.update(part["id"] for part in parts)
        lower = [min(part["mesh"]["bbox_min_m"][axis] for part in parts) for axis in range(3)]
        upper = [max(part["mesh"]["bbox_max_m"][axis] for part in parts) for axis in range(3)]
        materials = set(element["materials"] + [name for part in parts for name in part["materials"]])
        kind, classification_reason = classify_technology(element, family, materials)
        if phases[element['id']] == 'demolition':
            kind, classification_reason = 'demolition', 'Снос в выбранной исходной стадии Revit'
        plane = upper[2] if family in ("IfcBeam", "IfcMember", "IfcStair") else lower[2] if family == "IfcRoof" else upper[2] if family == "IfcSlab" and kind != "finish" else lower[2]
        plane = round(plane, 5)  # Ignore tessellation noise when ordering work on one elevation.
        phase = 0 if family in ("IfcFooting", "IfcBeam", "IfcMember") else 1 if family in ("IfcSlab", "IfcRoof") else 2 if family in ("IfcWall", "IfcColumn") else 4
        units.append({"id": element["id"], "name": element["name"], "class": element["class"], "family": family,
            "target_ids": [part["id"] for part in parts], "kind": kind, "lower": lower, "upper": upper,
            "plane": plane, "phase": phase, "materials": sorted(materials), "storey_id": element["storey_id"],
            "predefined_type": predefined(element),
            "quantities": unit_quantities(parts, family, lower[2] > (profile["parameters"]["ground_level_m"] or 0) + .1),
            "technology_status": "unresolved" if kind == "generic" else "assumed", "evidence": {"source_element_id": element["id"],
                "kind": "assumed", "rule": f"provisional_{kind}", "rule_version": PLANNER_VERSION,
                "reason": classification_reason}})
        units[-1]['source_instance_id'] = element.get('source_instance_id', 'model')
        units[-1]['revit_phase_status'] = phases[element['id']]
        if kind.startswith('mep_'):
            _, discipline, role = mep.technology(element, family)
            units[-1].update({'mep_discipline': discipline, 'mep_role': role})
    assign_roles(units)
    units.sort(key=sequence_key)
    unit_by_element = {key: unit for unit in units for key in [unit["id"], *unit["target_ids"]]}
    operations = []
    edges, unit_ops = [], {}
    templates = {
        "concrete": [("delivery", "Доставка арматуры и опалубки", {"truck": 1}, "none"),
            ("reinforcement", "Армирование", {"crew": 1}, "work"),
            ("formwork", "Монтаж опалубки", {"crew": 1}, "work"),
            ("inspection", "Контроль перед бетонированием", {"inspector": 1}, "none"),
            ("concreting", "Подача насосом, укладка и виброуплотнение бетона", {"concrete_crew": 1, "concrete_pump": 1, "mixer": 1, "vibrator": 1}, "work"),
            ("curing", f"Выдержка бетона {concrete_curing_days} сут. (допущение)", {}, "work"),
            ("strength_check", "Условный контроль готовности перед распалубкой", {"inspector": 1}, "none"),
            ("stripping", "Распалубка", {"crew": 1}, "work")],
        "masonry": [("delivery", "Доставка кладочных материалов", {"truck": 1}, "none"), ("masonry", "Кладка и устройство слоёв стены", {"crew": 1}, "work")],
        "steel": [("delivery", "Доставка стального элемента", {"truck": 1}, "none"), ("lifting", "Монтаж стального элемента", {"crane": 1, "crew": 1}, "work")],
        "timber": [("delivery", "Доставка деревянных элементов", {"truck": 1}, "none"), ("assembly", "Сборка деревянной конструкции", {"crew": 1}, "work")],
        "finish": [("finishing", "Устройство перегородки или слоёв отделки", {"crew": 1}, "work")],
        "opening": [("installation", "Установка заполнения проёма", {"crew": 1}, "work")],
        "generic": [("delivery", "Доставка — условный состав", {"truck": 1}, "none"), ("assembly", "Устройство элемента — технология требует уточнения", {"crew": 1}, "work")],
        'demolition': [('demolition', 'Демонтаж элемента · исходная стадия Revit', {'crew': 1}, 'work')],
    }
    for unit_index, unit in enumerate(units):
        previous = None
        unit_ops[unit["id"]] = []
        steps = mep.templates(unit) if unit['kind'].startswith('mep_') else templates[unit['kind']]
        for phase_index, (kind, name, demands, visual) in enumerate(steps):
            operation_id = f"{unit['id']}:{kind}"
            dependencies = [previous] if previous else ["site:prepare"]
            if previous:
                edges.append({"before": previous, "after": operation_id, "kind": "technology", "evidence": unit["evidence"]})
            if kind == "curing":
                operation = {"id": operation_id, "name": name, "kind": kind, "duration": concrete_readiness["hold_minutes"],
                    "demands": {}, "dependencies": dependencies, "duration_basis": {"method": "calendar_hold", "days": concrete_curing_days}, "evidence": dict(unit["evidence"])}
            else:
                work = mep.work(unit, kind, profile) if unit['kind'].startswith('mep_') else work_for(unit, kind, profile)
                rate_key = "timber_assembly" if kind == "assembly" and unit["kind"] == "timber" else kind
                operation = make_operation(operation_id, name, kind, work, demands, profile, dependencies, rate_key=rate_key)
            operation.update({"unit_id": unit["id"], "target_ids": unit["target_ids"],
                "priority": unit_index * 10 + phase_index + 1, "visual_phase": visual, "package_id": unit["kind"]})
            if kind in ("curing", "strength_check"):
                operation["concrete_readiness"] = dict(concrete_readiness)
                operation["evidence"]["duration_note"] = ("Календарная выдержка после окончания бетонирования, без случайного сокращения и без зависимости от скорости просмотра" if kind == "curing" else
                    "Синтетическая контрольная точка сценария; измеренная и требуемая прочность не заданы")
            operations.append(operation)
            unit_ops[unit["id"]].append(operation_id)
            previous = operation_id
        unit["operation_ids"] = unit_ops[unit["id"]]
        if unit['revit_phase_status'] == 'temporary':
            operation = make_operation(unit['id']+':demolition', 'Демонтаж временного элемента в той же стадии Revit',
                'demolition', {**unit['quantities']['count'], 'kind': 'assumed', 'requires_review': True,
                    'method': 'piece_count_fallback_missing_quantity'}, {'crew': 1}, profile,
                [previous], unit_id=unit['id'], target_ids=unit['target_ids'], visual_phase='work', package_id='demolition')
            operations.append(operation)
            unit_ops[unit['id']].append(operation['id'])
    site_ops, zero_cycle, root_gate, final_site_ops = site_package(model, units, profile)
    if root_gate == "site:blinding_readiness":
        site_ops.append({"id": "site:blinding_hold", "name": f"Выдержка бетонной подготовки {concrete_curing_days} сут. · допущение",
            "kind": "curing", "duration": concrete_readiness["hold_minutes"], "demands": {}, "dependencies": ["site:blinding"],
            "target_ids": [], "priority": 0, "visual_phase": "none", "package_id": "zero_cycle",
            "concrete_readiness": dict(concrete_readiness), "duration_basis": {"method": "calendar_hold", "days": concrete_curing_days},
            "evidence": {"kind": "assumed", "reason": "Прочность подготовки не известна, принято то же консервативное ожидание"}})
        readiness = make_operation("site:blinding_readiness", "Условный контроль бетонной подготовки", "strength_check",
            quantity(1, "check", "assumed", "synthetic_gate"), {"inspector": 1}, profile, ["site:blinding_hold"], package_id="zero_cycle")
        readiness["concrete_readiness"] = dict(concrete_readiness)
        site_ops.append(readiness)
    for unit in units:
        first = next(o for o in operations if o["id"] == unit["operation_ids"][0])
        first["dependencies"] = [root_gate]
    operations = site_ops + operations + final_site_ops
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
                              "Предварительный барьер: стены зоны перед каркасом/покрытием крыши; геометрия не подтверждает несущую схему" if rule in ("walls_before_roof_frame", "walls_before_roof", "frame_before_roof") else
                              "Консервативная последовательность по габаритам и виду работ; несущая способность не проверена"}})

    for unit in units:
        if unit['construction_role'] == 'mep':
            for before in units:
                if before['construction_role'] in ('structure', 'roof', 'roof_frame') and overlaps_xy(before, unit, .25) and before['lower'][2] <= unit['lower'][2] + .1:
                    link(before, unit, 'structure_before_mep')
                if before.get('mep_discipline') == unit['mep_discipline'] and before.get('mep_role') in ('equipment', 'segment') and unit['mep_role'] in ('fitting', 'terminal') and before.get('mep_role') != unit['mep_role'] and overlaps_xy(before, unit, .2) and abs(before['plane']-unit['plane']) < 1:
                    link(before, unit, 'assumed_mep_assembly_candidate')
            continue
        if unit['construction_role'] == 'demolition':
            continue
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
        role = unit["construction_role"]
        if role in ("roof", "roof_frame"):
            related_roofs = [roof for roof in units if roof["id"] in unit.get("related_roof_ids", [])]
            zones = related_roofs or [unit]
            for before in units:
                if before["family"] in ("IfcWall", "IfcColumn") and before["construction_role"] == "structure" and any(
                        overlaps_xy(before, zone, .5) and before["lower"][2] < zone["upper"][2] - .03 for zone in zones):
                    if role == "roof" or (sequence_key(before) < sequence_key(unit) and before["lower"][2] < unit["lower"][2] + .03):
                        link(before, unit, "walls_before_roof" if role == "roof" else "walls_before_roof_frame")
                if role == "roof" and before["construction_role"] == "roof_frame" and (
                        unit["id"] in before.get("related_roof_ids", []) or overlaps_xy(before, unit, .5) and
                        before["upper"][2] >= unit["lower"][2] - .03 and before["lower"][2] <= unit["upper"][2] + .03):
                    link(before, unit, "frame_before_roof")
        rank = sequence_key(unit)
        candidates = []
        for before in units:
            if before["kind"] in ("finish", "opening") or sequence_key(before) >= rank:
                continue
            overlap = overlaps_xy(before, unit)
            near = abs(before["upper"][2] - unit["lower"][2]) < 0.5
            zone_barrier = unit["family"] in ("IfcSlab", "IfcRoof") and before["family"] in ("IfcBeam", "IfcMember") and abs(before["upper"][2] - unit["lower"][2]) < 0.5
            # AABB overlap is a candidate sequencing constraint, never a proof of structural support.
            if (overlap and (near or before["family"] == "IfcFooting")) or zone_barrier:
                candidates.append(before)
        if not candidates and unit["family"] != "IfcFooting":
            candidates = [before for before in units if before["family"] == "IfcFooting" and before["plane"] < unit["plane"]]
        for before in candidates:
            link(before, unit, "geometry_sequence_candidate")
    more = variant == "reinforced"
    systems = mep.finish_systems(model, units, operations, profile)
    access = access_packages(model, units, operations, profile, root_gate, 4 if more else 2)
    resources = [{"id": key, "name": name, "capacity": capacity, "kind": "renewable"} for key, name, capacity in (
        ("crew", "Строительные бригады", 6 if more else 3), ("truck", "Доставка", 2 if more else 1),
        ("crane", "Краны", 2 if more else 1), ("concrete_crew", "Бетонирование", 2 if more else 1),
        ("inspector", "Условный контроль", 1), ("surveyor", "Геодезическое звено", 1),
        ("concrete_pump", "Бетононасосы", 2 if more else 1), ("mixer", "Автобетоносмесители", 2 if more else 1),
        ("vibrator", "Виброуплотнение", 2 if more else 1), ("excavator", "Экскаваторы", 1),
        ("dump_truck", "Самосвалы", 2 if more else 1), ("compactor", "Уплотнение грунта", 1),
        ('hvac_crew', 'Монтажники вентиляции', 2 if more else 1), ('pipe_crew', 'Монтажники трубопроводов', 2 if more else 1),
        ('electrical_crew', 'Электромонтажники', 2 if more else 1), ('commissioning_crew', 'Проверка и наладка', 2 if more else 1),
        ('scaffold_crew', 'Сборщики лесов и подмостей', 2 if more else 1), ('access_tower', 'Вышки-туры', 4 if more else 2),
        ('scaffold_access', 'Рабочие места на фасадных лесах', 6 if more else 3))]
    for resource in resources:
        resource["people_per_slot"] = profile["crew_people"].get(resource["id"])
        resource["evidence"] = {"kind": "assumed", "basis": "scenario_resource_package"}
    # The dependency graph includes auxiliary package edges as well as element
    # technology chains. Consumers need not reconstruct hidden planner rules.
    existing_edges = {(edge["before"], edge["after"]) for edge in edges}
    for operation in operations:
        for before in operation["dependencies"]:
            if (before, operation["id"]) not in existing_edges:
                edges.append({"before": before, "after": operation["id"], "kind": "package_gate",
                    "evidence": {"kind": "assumed", "rule_version": PLANNER_VERSION, "reason": "Связь технологического пакета"}})
    packages = [{"id": kind, "status": "unresolved" if kind == "generic" else "provisional",
        "unit_ids": [unit["id"] for unit in units if unit["kind"] == kind],
        "operation_kinds": sorted({o["kind"] for o in operations if o.get("package_id") == kind}),
        "resource_ids": sorted({r for o in operations if o.get("package_id") == kind for r in o["demands"]})}
        for kind in sorted({unit["kind"] for unit in units})]
    scenario = {"contract": "ScenarioPackage", "contract_version": "0.1.0", "model_id": model["model_id"],
        "id": variant, "name": "Усиленные ресурсы" if more else "Базовые ресурсы", "seed": seed,
        "planner_version": PLANNER_VERSION, "production_profile": profile, "technology_packages": packages,
        "work_packages": [zero_cycle], "concrete_readiness_policy": concrete_readiness, "operations": operations, "resources": resources,
        "dependencies": edges, "units": units, 'temporary_assets': access, 'mep_systems': systems,
        'revit_phase_context': contexts, 'element_phase_states': phases,
        'initial_element_ids': initial + [key for key, state in phases.items() if state == 'demolition' and elements[key]['role']=='element'],
        'excluded_element_ids': excluded, "unplanned_element_ids": [element["id"] for element in model["elements"] if element["role"] == "element" and element["id"] not in claimed and element['id'] not in initial + excluded],
        "assumptions": ["Длительность = объём / производительность назначенного ресурса; темп работ — допущение, не норматив. Календарь непрерывный, без смен и погоды",
                        "Количество: BaseQuantities IFC в SI, иначе измерение меша; при отсутствии количества явно отмечен расчёт поштучно",
                        "Нулевой цикл предварительный: грунты, УГВ, границы участка и безопасная геометрия котлована неизвестны",
                        "Монтаж опалубки виден в 3D; контактные поверхности приближены по граням IFC, проект опалубки не разработан",
                        f"Бетон: выдержка {concrete_curing_days} календарных суток после бетонирования — допущение сценария; прочность не измерена, реальные сроки распалубки и нагружения не подтверждены",
                        "Технологии предварительные; ПОС/ППР и несущая схема не подтверждены",
                        "Контрольные точки проходят синтетически, без подтверждения реальной приёмки", "Классы без технологии исключены из виртуального строительства и сохранены в модели"],
        "tick_unit": "minute"}
    scenario['assumptions'].extend(['Инженерные сети: крепления, темпы, монтажные связи и ПНР предварительные; фактические испытания не выполняются',
        'Леса, вышки-туры и рабочие места — временные ресурсы сценария. Высотный порог и шаг креплений приняты; анкеровка, нагрузки и устойчивость не рассчитаны',
        'Стадии читаются отдельно для каждого RVT; неизвестные стадии не заменяются догадками. Фазы RVT не равны строительным операциям.'])
    if model.get("source", {}).get("conversion") or any(e.get("geometry_evidence") for e in model["elements"]):
        blocked = [e["id"] for e in model["elements"] if e.get("geometry_evidence", {}).get("quantity_eligible") is False]
        scenario["conversion_quantity_policy"] = {"engine": "rvt-rs", "quantity_blocked_element_ids": blocked,
            "method": "box_and_unknown_bodies_excluded_from_volume_and_area", "requires_review": True}
        scenario["assumptions"].append("RVT → IFC экспериментальный: состав и геометрия могут быть неполными. Габаритные блоки и тела неизвестного происхождения не дают объёмы/площади работ; вместо них явно принят поштучный расчёт. Декодированные тела также требуют проверки.")
    validate_scenario(scenario)
    return scenario
