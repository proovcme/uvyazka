"""Site-wide auxiliary work packages. No project names, IDs or fitted dimensions."""
from .production import make_operation
from .quantities import quantity


def site_package(model, units, profile):
    elements = [e for e in model["elements"] if e["role"] == "element" and e.get("mesh")]
    lower = [min(e["mesh"]["bbox_min_m"][axis] for e in elements) for axis in range(3)]
    upper = [max(e["mesh"]["bbox_max_m"][axis] for e in elements) for axis in range(3)]
    area = (upper[0] - lower[0]) * (upper[1] - lower[1])
    q = quantity(area, "m2", "assumed", "physical_model_aabb_site_proxy", bounds=[lower, upper],
        reason="Граница строительной площадки в IFC не установлена; габарит здания — приближение")
    op = lambda key, name, kind, work, demands, deps: make_operation("site:" + key, name, kind, work, demands, profile, deps, package_id="site")
    operations = [op("survey", "Геодезическая основа · обследование площадки", "survey", q, {"surveyor": 1}, []),
        op("prepare", "Подготовка площадки и временных проездов · допущение", "preparation", q, {"crew": 1}, ["site:survey"]),
        op("setting_out", "Геодезическая разбивка осей", "setting_out", q, {"surveyor": 1}, ["site:prepare"])]
    ground = profile["parameters"]["ground_level_m"]
    if ground is None:
        ground = 0.0
    foundations = [u for u in units if u["family"] == "IfcFooting"]
    metadata = {"id": "zero_cycle", "status": "provisional" if foundations else "requires_input",
        "ground_level_m": ground, "ground_basis": "scenario_parameter" if profile["parameters"]["ground_level_m"] is not None else "assumed_ifc_z_zero_not_surveyed_terrain",
        "foundation_unit_ids": [u["id"] for u in foundations], "unresolved": [
            {"work": "Ограждение котлована / откосы", "needs": "Грунты, глубина, соседи, расчёт устойчивости"},
            {"work": "Водопонижение и дренаж", "needs": "УГВ, приток, проект водозащиты"},
            {"work": "Сваи / улучшение основания", "needs": "Изыскания и конструктивный проект"},
            {"work": "Перенос сетей / снос", "needs": "Обследование и существующие коммуникации"}],
        "note": "Автоматически включённые вспомогательные работы — вариант сценария, не установленный состав ПОС/ППР"}
    if not foundations:
        metadata["reason"] = "IfcFooting не найден: фундамент и котлован не выдумываются по одной нижней плите"
        return operations, metadata, "site:setting_out", []
    margin = profile["parameters"]["working_space_m"]
    flo = [min(u["lower"][a] for u in foundations) for a in range(3)]
    fhi = [max(u["upper"][a] for u in foundations) for a in range(3)]
    # A vertical envelope is a volume proxy, never a designed safe excavation.
    blinding_thickness = profile["parameters"]["blinding_thickness_m"]
    depth = max(0, ground - flo[2] + blinding_thickness)
    if depth <= 0:
        metadata["status"] = "requires_input"
        metadata["reason"] = "Фундаменты не ниже принятой отметки земли; глубина выемки неизвестна"
        return operations, metadata, "site:setting_out", []
    base_area = (fhi[0] - flo[0]) * (fhi[1] - flo[1])
    pit_area = (fhi[0] - flo[0] + 2 * margin) * (fhi[1] - flo[1] + 2 * margin)
    pit_bounds = [[flo[0] - margin, flo[1] - margin, flo[2] - blinding_thickness], [fhi[0] + margin, fhi[1] + margin, ground]]
    pit = quantity(pit_area * depth, "m3", "assumed", "foundation_envelope_plus_working_space", bounds=pit_bounds,
        working_space_m=margin, ground_level_m=ground, requires_geotechnical_design=True)
    base = quantity(pit_area, "m2", "assumed", "excavation_bottom_proxy", bounds=pit_bounds)
    blinding = quantity(base_area * profile["parameters"]["blinding_thickness_m"], "m3", "assumed", "base_area_times_assumed_thickness",
        area_m2=base_area, thickness_m=profile["parameters"]["blinding_thickness_m"])
    backfill = quantity((pit_area - base_area) * depth, "m3", "assumed", "working_space_prism_only", bounds=pit_bounds)
    waterproof = quantity(2 * ((fhi[0] - flo[0]) + (fhi[1] - flo[1])) * depth, "m2", "assumed", "underground_envelope_side_area")
    operations += [op("excavation", "Разработка котлована и вывоз грунта · предварительный контур", "excavation", pit, {"excavator": 1, "dump_truck": 1}, ["site:setting_out"]),
        op("subgrade", "Доработка и уплотнение основания", "subgrade", base, {"crew": 1, "compactor": 1}, ["site:excavation"]),
        op("base_acceptance", "Контроль основания · условная приёмка", "inspection", base, {"inspector": 1}, ["site:subgrade"]),
        op("blinding", f"Бетонная подготовка · принято {blinding_thickness * 1000:g} мм", "blinding", blinding, {"concrete_crew": 1, "concrete_pump": 1, "mixer": 1, "vibrator": 1}, ["site:base_acceptance"])]
    # Preparation concrete must also have its own age/readiness policy, inserted
    # by the planner before foundation work. Never mark it ready after one shift.
    underground = [u for u in units if u["family"] in ("IfcFooting", "IfcWall", "IfcSlab", "IfcColumn") and u["lower"][2] < ground and u["upper"][2] <= ground + .5]
    predecessors = [u["operation_ids"][-1] for u in underground]
    finish = [op("waterproofing", "Гидроизоляция подземного контура · допущение", "waterproofing", waterproof, {"crew": 1}, predecessors),
        op("backfill", "Обратная засыпка пазух · допущение", "backfill", backfill, {"excavator": 1, "dump_truck": 1}, ["site:waterproofing"]),
        op("compaction", "Послойное уплотнение засыпки", "compaction", backfill, {"crew": 1, "compactor": 1}, ["site:backfill"]),
        op("as_built", "Исполнительная геодезическая съёмка нулевого цикла", "as_built", base, {"surveyor": 1}, ["site:compaction"])]
    metadata.update({"excavation_quantity": pit, "backfill_quantity": backfill, "pit_bounds_m": pit_bounds,
        "underground_unit_ids": [u["id"] for u in underground]})
    return operations, metadata, "site:blinding_readiness", finish
