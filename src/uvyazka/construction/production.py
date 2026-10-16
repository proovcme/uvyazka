"""Configurable demonstration production rates, deliberately NOT GESN norms.

Rates are per assigned resource slot per continuous hour. Pool capacity only
affects concurrency; it never secretly multiplies a single operation's crew.
"""
from copy import deepcopy
import math

from .quantities import quantity

CAPACITY_ONLY_RESOURCES = {'access_tower', 'scaffold_access'}

PROFILE = {
    "id": "provisional-production-1", "status": "assumed", "calendar": "continuous_24h",
    "crew_people": {"crew": 2, "concrete_crew": 2, "inspector": 1, "surveyor": 2,
        "hvac_crew": 2, "pipe_crew": 2, "electrical_crew": 2, "scaffold_crew": 2, "commissioning_crew": 2},
    "rates": {  # quantity unit / assigned slot / hour
        "preparation": {"crew": 40}, "survey": {"surveyor": 100}, "setting_out": {"surveyor": 60},
        "excavation": {"excavator": 25, "dump_truck": 8}, "subgrade": {"crew": 12, "compactor": 30},
        "blinding": {"concrete_crew": 4, "concrete_pump": 12, "mixer": 8, "vibrator": 8},
        "reinforcement": {"crew": 35}, "formwork": {"crew": 4}, "inspection": {"inspector": 25},
        "concreting": {"concrete_crew": 6, "concrete_pump": 12, "mixer": 8, "vibrator": 8},
        "strength_check": {"inspector": 4}, "stripping": {"crew": 8}, "masonry": {"crew": .5},
        "lifting": {"crew": .5, "crane": 2}, "timber_assembly": {"crew": .3},
        "finishing": {"crew": 3}, "installation": {"crew": 2}, "assembly": {"crew": .5},
        "delivery": {"truck": 5}, "waterproofing": {"crew": 5}, "backfill": {"excavator": 20, "dump_truck": 8},
        "compaction": {"compactor": 10, "crew": 15}, "as_built": {"surveyor": 100},
        "mep_delivery": {"truck": 4}, "duct_install": {"hvac_crew": 8},
        "pipe_install": {"pipe_crew": 6}, "cable_install": {"electrical_crew": 12},
        "mep_fitting": {"hvac_crew": 3, "pipe_crew": 3, "electrical_crew": 3},
        "mep_terminal": {"hvac_crew": 2, "pipe_crew": 2, "electrical_crew": 2},
        "mep_equipment": {"hvac_crew": .5, "pipe_crew": .5, "electrical_crew": .5},
        "mep_supports": {"hvac_crew": 4, "pipe_crew": 4, "electrical_crew": 4},
        "mep_check": {"commissioning_crew": 2}, "commissioning": {"commissioning_crew": .5},
        "scaffold_install": {"scaffold_crew": 20}, "scaffold_remove": {"scaffold_crew": 30},
        "access_setup": {"scaffold_crew": 2}, "access_remove": {"scaffold_crew": 4},
        "access_check": {"inspector": 4}, "demolition": {"crew": .4}},
    "parameters": {"rebar_kg_per_m3": 100, "steel_density_kg_m3": 7850, "working_space_m": 1, "blinding_thickness_m": .1,
        "ground_level_m": None, "height_access_threshold_m": 1.8, "hanger_spacing_m": 2},
    "note": "Все производительности — редактируемые допущения сценария, не нормативы. Доставка: эффективные 5 м³/ч на машину; вывоз 8 м³/ч. Маршруты, смены и грунты не заданы."}


RATE_UNITS = {"preparation": "m2", "survey": "m2", "setting_out": "m2", "excavation": "m3",
    "subgrade": "m2", "blinding": "m3", "reinforcement": "kg", "formwork": "m2", "inspection": "m2",
    "concreting": "m3", "strength_check": "check", "stripping": "m2", "masonry": "m3", "lifting": "t",
    "timber_assembly": "m3", "finishing": "m2", "installation": "m2", "assembly": "m3", "delivery": "m3",
    "waterproofing": "m2", "backfill": "m3", "compaction": "m3", "as_built": "m2",
    "mep_delivery": "piece", "duct_install": "m", "pipe_install": "m", "cable_install": "m",
    "mep_fitting": "piece", "mep_terminal": "piece", "mep_equipment": "piece", "mep_supports": "piece",
    "mep_check": "check", "commissioning": "check", "scaffold_install": "m2", "scaffold_remove": "m2",
    "access_setup": "piece", "access_remove": "piece", "access_check": "check", "demolition": "m3"}


def production_profile(overrides=None):
    result = deepcopy(PROFILE)
    if overrides is None:
        return result
    if not isinstance(overrides, dict) or set(overrides) - {"rates", "crew_people", "parameters"}:
        raise ValueError("Неизвестные параметры производительности")
    for section, values in overrides.items():
        if not isinstance(values, dict) or set(values) - set(result[section]):
            raise ValueError("Неизвестные ресурсы или параметры профиля")
        for key, value in values.items():
            if section == "rates":
                if not isinstance(value, dict) or set(value) != set(result[section][key]):
                    raise ValueError("Нужно задать производительность каждого ресурса операции")
                for rate in value.values():
                    if type(rate) not in (int, float) or not math.isfinite(rate) or rate <= 0:
                        raise ValueError("Производительность должна быть положительной")
            elif section == "crew_people":
                if type(value) is not int or not 1 <= value <= 20:
                    raise ValueError("Состав звена: от 1 до 20 человек")
            elif value is not None and (type(value) not in (int, float) or not math.isfinite(value) or (key != "ground_level_m" and value <= 0)):
                raise ValueError("Некорректный параметр технологии")
            result[section][key] = value
    return result


def calculate_duration(work, rate_key, demands, profile):
    if work["value"] <= 0 or not math.isfinite(work["value"]):
        raise ValueError("Объём работы недоступен или неположителен")
    rates = profile["rates"][rate_key]
    if work["unit"] != RATE_UNITS[rate_key] and not work.get("requires_review"):
        raise ValueError("Единица количества не совпадает с единицей производительности")
    limits = []
    for resource, slots in demands.items():
        if resource in CAPACITY_ONLY_RESOURCES:
            continue
        rate = rates[resource]
        # Base rate refers to the baseline crew; changing people changes output.
        people = profile["crew_people"].get(resource)
        factor = people / PROFILE["crew_people"][resource] if people else 1
        output = rate * slots * factor
        limits.append({"resource_id": resource, "assigned_slots": slots, "people_per_slot": people,
            "rate_per_slot_hour": rate, "effective_output_per_hour": output, "rate_unit": work["unit"] + "/slot/hour",
            "hours": work["value"] / output, "kind": "assumed"})
    hours = max(item["hours"] for item in limits)
    minutes = max(1, math.ceil(hours * 60 - 1e-9))
    return minutes, {"method": "quantity_resource_bottleneck", "quantity": work, "rate_key": rate_key,
        "limits": limits, "unrounded_hours": hours, "rounding": "ceil_to_minute", "profile_id": profile["id"],
        "formula": "ceil(60 × Q / min(rate × assigned_slots × crew_size_factor))", "rate_status": "assumed",
        "capacity_only_resources": [r for r in demands if r in CAPACITY_ONLY_RESOURCES]}


def work_for(unit, kind, profile):
    q = unit["quantities"]
    fallback = lambda missing: {**q["count"], "kind": "assumed", "method": "piece_count_fallback_missing_quantity",
        "missing_quantity": missing, "requires_review": True}
    if kind == "reinforcement":
        if q["volume"]["value"] <= 0:
            return fallback(q["volume"])
        factor = profile["parameters"]["rebar_kg_per_m3"]
        return quantity(q["volume"]["value"] * factor, "kg", "assumed", "concrete_volume_times_assumed_rebar_ratio",
            concrete_quantity=q["volume"], kg_per_m3=factor)
    if kind in ("formwork", "stripping", "inspection"):
        return q["formwork_area"] if q["formwork_area"]["value"] > 0 else fallback(q["formwork_area"])
    if kind == "strength_check":
        return quantity(1, "check", "assumed", "one_synthetic_readiness_gate_per_unit")
    if kind in ("finishing", "installation"):
        work = q["area"]
    elif kind == "lifting":
        if q["mass"]["value"] > 0:
            return quantity(q["mass"]["value"] / 1000, "t", q["mass"]["kind"], "ifc_mass_kg_to_t", mass_quantity=q["mass"])
        if q["volume"]["value"] > 0:
            density = profile["parameters"]["steel_density_kg_m3"]
            return quantity(q["volume"]["value"] * density / 1000, "t", "assumed", "steel_volume_times_assumed_density",
                volume_quantity=q["volume"], density_kg_m3=density, load_capacity_verified=False)
        return fallback(q["mass"])
    else:
        work = q["volume"]
    if work["value"] <= 0:
        # Explicit low-confidence fallback, rather than a fabricated m3 value.
        return {**q["count"], "kind": "assumed", "method": "piece_count_fallback_missing_quantity",
            "missing_quantity": work, "requires_review": True}
    return work


def make_operation(key, name, kind, work, demands, profile, dependencies=(), **fields):
    # A count fallback must use a count-based productivity, not a m3/hour rate.
    rate_key = fields.pop("rate_key", kind)
    local_profile = profile
    if work.get("requires_review"):
        local_profile = deepcopy(profile)
        local_profile["rates"][rate_key] = {resource: .5 for resource in demands}
    duration, basis = calculate_duration(work, rate_key, demands, local_profile)
    return {"id": key, "name": name, "kind": kind, "target_ids": [], "duration": duration,
        "demands": dict(demands), "dependencies": list(dependencies), "priority": 0, "visual_phase": "none",
        "work_quantity": work, "duration_basis": basis,
        "evidence": {"kind": "assumed", "basis": "quantity_and_assumed_productivity",
            "reason": "Количество и производительность раскрыты отдельно; технология требует проверки"}, **fields}
