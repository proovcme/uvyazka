"""Project-scoped, immutable construction scenarios, models and calculation runs.

Sources can be PDF pages, registered DWG files, table rows or observation
revisions. Scheduling itself requires no IFC, CAD program or model API.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_CEILING, localcontext
import json
from pathlib import Path
import re
import shutil
from uuid import uuid4

from ..core import Workspace, UNITS, connection, digest, encode, now
from .geometry import box_model
from .simulation import SimulationEngine, canonical_hash, validate_scenario

SQL = [
    "create table if not exists construction_models(model_id text primary key,payload text not null)",
    "create table if not exists construction_scenarios(scenario_id text not null,revision integer not null,payload text not null,primary key(scenario_id,revision))",
    "create table if not exists construction_runs(run_id text primary key,payload text not null)",
    "create table if not exists construction_requests(request_id text primary key,fingerprint text not null,result text not null)",
]


def bounded(items: list, offset: int = 0, limit: int = 40) -> dict:
    offset = max(0, int(offset)); limit = max(1, min(int(limit), 200)); page = items[offset:offset+limit]
    return {"items": page, "total": len(items), "offset": offset, "next_offset": offset+len(page) if offset+len(page) < len(items) else None}


def duration_from_quantity(calculation: dict) -> int:
    """Effective productivity is for the operation as a whole, not per worker."""
    try:
        quantity = Decimal(str(calculation["quantity"]))
        rate = Decimal(str(calculation["production_per_hour"]))
        if any(not n.is_finite() or n <= 0 or len(n.as_tuple().digits) > 64 or abs(n.as_tuple().exponent) > 100 for n in (quantity, rate)):
            raise ValueError("Positive finite bounded quantities and productivity required")
        q, r = UNITS.get(calculation["quantity_unit"]), UNITS.get(calculation["production_unit"])
        if not q or not r or q[0] != r[0]:
            raise ValueError("Quantity and hourly productivity need compatible explicit units")
        with localcontext() as ctx:
            ctx.prec = 220
            result = int((quantity * Decimal(q[1]) / (rate * Decimal(r[1])) * 60).to_integral_value(rounding=ROUND_CEILING))
        if not 1 <= result <= 52560000:
            raise ValueError("Duration exceeds the supported minute range")
        return result
    except (KeyError, InvalidOperation, TypeError) as exc:
        raise ValueError("calculation needs quantity, quantity_unit, production_per_hour, production_unit") from exc


def cpm(scenario: dict) -> dict:
    """FS-only longest path and floats without resource constraints/calendars."""
    ops = {o["id"]: o for o in scenario["operations"]}; remaining = set(ops); order = []; starts = {}; ends = {}
    while remaining:
        ready = sorted(k for k in remaining if all(p in ends for p in ops[k]["dependencies"]))
        if not ready:
            raise ValueError("Cycle in dependency graph")
        for key in ready:
            starts[key] = max((ends[p] for p in ops[key]["dependencies"]), default=0)
            ends[key] = starts[key] + ops[key]["duration"]; order.append(key); remaining.remove(key)
    duration = max(ends.values(), default=0); successors = {k: [] for k in ops}; latest = {}
    for key, op in ops.items():
        for parent in op["dependencies"]:
            successors[parent].append(key)
    for key in reversed(order):
        finish = min((latest[k] for k in successors[key]), default=duration)
        latest[key] = finish - ops[key]["duration"]
    return {"duration_minutes": duration, "scope": "Dependencies only; FS without lag, calendars or resource constraints",
        "operations": {k: {"early_start": starts[k], "early_finish": ends[k], "late_start": latest[k], "total_float": latest[k]-starts[k], "critical": latest[k] == starts[k]} for k in order}}


class Planning:
    def __init__(self, workspace: Workspace):
        self.workspace = workspace

    def _db(self, project_id):
        path = self.workspace.db_path(project_id)
        with connection(path) as db:
            for sql in SQL:
                db.execute(sql)
        return path

    def _rows(self, project_id, table):
        assert table in {"construction_models", "construction_scenarios", "construction_runs"}
        path = self.workspace.db_path(project_id)
        with connection(path, readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where type='table' and name=?", (table,)).fetchone():
                return []
            return [json.loads(r[0]) for r in db.execute("select payload from " + table)]

    def _save(self, project_id, table, payload, request_id, fingerprint):
        if not request_id or len(request_id) > 128:
            raise ValueError("request_id of 1–128 characters required")
        with connection(self._db(project_id)) as db:
            db.execute("begin immediate")
            old = db.execute("select * from construction_requests where request_id=?", (request_id,)).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    raise ValueError("request_id already used for another construction request")
                return json.loads(old["result"])
            if table == "construction_scenarios":
                current = db.execute("select max(revision) from construction_scenarios where scenario_id=?", (payload["id"],)).fetchone()[0] or 0
                if current != payload["revision"]-1:
                    raise ValueError("Scenario changed; reread its revision before saving")
                db.execute("insert into construction_scenarios values (?,?,?)", (payload["id"], payload["revision"], encode(payload)))
                result = self.scenario_summary(payload)
            elif table == "construction_models":
                db.execute("insert or ignore into construction_models values (?,?)", (payload["model_id"], encode(payload)))
                result = self.model_summary(payload)
            else:
                db.execute("insert or ignore into construction_runs values (?,?)", (payload["run_id"], encode(payload)))
                result = self.run_summary(payload)
            db.execute("insert into construction_requests values (?,?,?)", (request_id, fingerprint, encode(result)))
            db.execute("insert into events(created_at,kind,payload) values (?,?,?)", (now(), table, encode(result)))
        return result

    def _retry(self, project_id, request_id, fingerprint):
        with connection(self._db(project_id), readonly=True) as db:
            row = db.execute("select * from construction_requests where request_id=?", (request_id,)).fetchone()
        if not row:
            return None
        if row["fingerprint"] != fingerprint:
            raise ValueError("request_id already used with different inputs")
        return json.loads(row["result"])

    def validate_sources(self, project_id, sources: list[dict], _seen=None):
        seen = set() if _seen is None else _seen
        if not isinstance(sources, list) or len(sources) > 200:
            raise ValueError("At most 200 exact source pointers per item")
        for source in sources:
            if "fact_id" in source:
                fact = self.workspace.get_evidence_chain(project_id, source["fact_id"])["fact"]
                if source.get("revision") != fact["revision"]:
                    raise ValueError("Observation revision changed")
                self.validate_sources(project_id, fact["sources"], seen)
                continue
            record, path = self.workspace.source_record(project_id, source["doc_id"])
            cache_key = (source["doc_id"], source.get("sha256"))
            if cache_key not in seen and (not path.is_file() or path.stat().st_size > 100*1024*1024 or digest(path) != source.get("sha256")):
                raise ValueError("Source fingerprint changed or source unavailable")
            seen.add(cache_key)
            if "page_number" in source:
                evidence = self.workspace.read_evidence(project_id, source["doc_id"], int(source["page_number"]), sha256=source["sha256"], parser_revision=source.get("parser_revision"))
                if evidence["freshness"]["status"] == "historical_snapshot":
                    raise ValueError("Extraction version changed; reread the source")
            elif not source.get("locator"):
                raise ValueError("File evidence needs a locator, e.g. DWG handle or IFC GlobalId")

    @staticmethod
    def scenario_summary(s):
        return {k: s[k] for k in ("project_id", "id", "revision", "name", "model_id", "created_at")} | {"operation_count": len(s["operations"]), "resource_count": len(s["resources"]), "status": "unapproved_scenario", "tick_unit": "minute"}

    @staticmethod
    def model_summary(m):
        return {"project_id": m["project_id"], "model_id": m["model_id"], "name": m["source"]["filename"], "schema": m["source"]["schema"], "statistics": m["statistics"], "geometry_kind": "approximate_boxes" if m["source"].get("kind") == "derived" else "ifc_geometry"}

    @staticmethod
    def run_summary(r):
        return {"project_id": r["project_id"], "run_id": r["run_id"], "scenario_id": r["scenario"]["id"], "scenario_revision": r["scenario"]["revision"], "duration_minutes": r["duration"], "dependency_duration_minutes": r["cpm"]["duration_minutes"], "operation_count": len(r["scenario"]["operations"]), "event_count": len(r["events"]), "status": r["status"], "interpretation": "Calculated scenario, not an approved schedule or construction actuals"}

    def list_models(self, project_id, offset=0, limit=40):
        return {"project_id": project_id, **bounded([self.model_summary(m) for m in self._rows(project_id, "construction_models")], offset, limit)}

    def model(self, project_id, model_id):
        if not re.fullmatch(r"[a-f0-9]{64}", model_id or ""):
            raise ValueError("Invalid model_id")
        model = next((m for m in self._rows(project_id, "construction_models") if m["model_id"] == model_id), None)
        if not model:
            raise ValueError("Unknown model in selected project")
        return model

    def model_path(self, project_id, model_id):
        self.model(project_id, model_id)
        return self.workspace.db_path(project_id).parent / "construction/models" / model_id

    def model_elements(self, project_id, model_id, offset=0, limit=40):
        m = self.model(project_id, model_id)
        return {**self.model_summary(m), **bounded(m["elements"], offset, limit)}

    def save_model(self, project_id, name, elements, request_id, sources=None, assumptions=None):
        sources = sources or []; assumptions = assumptions or []
        if len(encode(elements)) > 2000000:
            raise ValueError("Spatial model input exceeds 2 million characters")
        fingerprint = canonical_hash(["boxes", name, elements, sources, assumptions])
        if old := self._retry(project_id, request_id, fingerprint):
            return old
        seen = set()
        self.validate_sources(project_id, sources, seen)
        for element in elements:
            self.validate_sources(project_id, element.get("sources", []), seen)
        if not sources and not assumptions:
            raise ValueError("A document-led model needs sources or explicit assumptions")
        model, binary = box_model(name, elements, sources, assumptions); model["project_id"] = project_id
        folder = self.workspace.db_path(project_id).parent / "construction/models" / model["model_id"]
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / (uuid4().hex + ".tmp"); target.write_bytes(binary); target.replace(folder / "geometry.bin")
        return self._save(project_id, "construction_models", model, request_id, fingerprint)

    def import_ifc(self, project_id, doc_id, request_id):
        record, source = self.workspace.source_record(project_id, doc_id)
        if source.suffix.lower() != ".ifc" or not 0 < source.stat().st_size <= 100*1024*1024:
            raise ValueError("Choose a registered .ifc file <=100 MiB")
        before = digest(source); fingerprint = canonical_hash(["ifc", doc_id, before])
        if old := self._retry(project_id, request_id, fingerprint):
            return old
        try:
            from .importer import import_model
        except ImportError as exc:
            raise ValueError("Install the optional uvyazka[ifc] extra for native IFC import") from exc
        base = self.workspace.db_path(project_id).parent / "construction/models"; base.mkdir(parents=True, exist_ok=True)
        temporary = base / ("import-" + uuid4().hex); temporary.mkdir()
        try:
            import_model(str(source), str(temporary), record["relative_path"])
            if digest(source) != before:
                raise ValueError("IFC changed during import")
            model = json.loads((temporary / "manifest.json").read_text(encoding="utf-8"))
            model["project_id"] = project_id
            model["source"]["sources"] = [{"doc_id": doc_id, "sha256": before, "locator": "IFC file; individual objects carry STEP id and GlobalId"}]
            destination = base / model["model_id"]; destination.mkdir(exist_ok=True)
            (temporary / "geometry.bin").replace(destination / "geometry.bin")
            return self._save(project_id, "construction_models", model, request_id, fingerprint)
        finally:
            # This newly created import directory is inside this project's model cache.
            if temporary.resolve().is_relative_to(base.resolve()):
                shutil.rmtree(temporary)

    def scenario(self, project_id, scenario_id, revision=None):
        versions = [s for s in self._rows(project_id, "construction_scenarios") if s["id"] == scenario_id and (revision is None or s["revision"] == revision)]
        if not versions:
            raise ValueError("Unknown scenario/revision in selected project")
        return max(versions, key=lambda s: s["revision"])

    def list_scenarios(self, project_id, offset=0, limit=40):
        latest = {}
        for s in self._rows(project_id, "construction_scenarios"):
            if s["revision"] > latest.get(s["id"], {}).get("revision", 0):
                latest[s["id"]] = s
        return {"project_id": project_id, **bounded([self.scenario_summary(s) for s in latest.values()], offset, limit)}

    def scenario_page(self, project_id, scenario_id, revision=None, offset=0, limit=40):
        s = self.scenario(project_id, scenario_id, revision)
        return {**self.scenario_summary(s), "resources": s["resources"], "sources": s["sources"], "assumptions": s["assumptions"], **bounded(s["operations"], offset, limit)}

    def save_scenario(self, project_id, scenario, request_id, expected_revision=None, merge=False):
        fingerprint = canonical_hash(["scenario", scenario, expected_revision, merge])
        if len(encode(scenario)) > 2000000:
            raise ValueError("Scenario input exceeds 2 million characters")
        if old := self._retry(project_id, request_id, fingerprint):
            return old
        scenario = json.loads(encode(scenario)); key = scenario.get("id", "")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}", key):
            raise ValueError("Choose a scenario ID of 1–80 ASCII letters, digits, . _ : -")
        versions = [s for s in self._rows(project_id, "construction_scenarios") if s["id"] == key]
        previous = max(versions, key=lambda s: s["revision"]) if versions else None
        current_revision = previous["revision"] if previous else 0
        if (previous and expected_revision != current_revision) or (not previous and expected_revision not in (None, 0)):
            raise ValueError("expected_revision must match the current scenario revision")
        if merge:
            if not previous:
                raise ValueError("Merge requires an existing scenario")
            merged = {**previous, **scenario}
            for field in ("operations", "resources"):
                items = {item["id"]: item for item in previous[field]}
                for item in scenario.get(field, []):
                    if item.get("remove"):
                        items.pop(item["id"], None)
                    else:
                        items[item["id"]] = item
                merged[field] = list(items.values())
            scenario = merged
        operations, resources = scenario.get("operations", []), scenario.get("resources", [])
        if not scenario.get("name") or not 1 <= len(operations) <= 2000 or len(resources) > 100:
            raise ValueError("A name, 1–2000 operations and <=100 resources required")
        model_id = scenario.get("model_id")
        model = self.model(project_id, model_id) if model_id else None
        target_ids = {e["id"] for e in model["elements"]} if model else set()
        all_sources = scenario.get("sources", [])
        seen = set()
        self.validate_sources(project_id, all_sources, seen)
        if model:
            self.validate_sources(project_id, model["source"].get("sources", []), seen)
        for r in resources:
            if not isinstance(r.get("id"), str) or not r["id"] or len(r["id"]) > 80:
                raise ValueError("Each resource needs a string ID of 1–80 characters")
            if type(r.get("capacity")) is not int or not 1 <= r["capacity"] <= 100000:
                raise ValueError("Resource capacities must be positive bounded integers")
            r.setdefault("name", r["id"])
        for index, op in enumerate(operations):
            if not isinstance(op.get("id"), str) or not 1 <= len(op["id"]) <= 80 or not op.get("name"):
                raise ValueError("Each operation needs id and name")
            op.setdefault("dependencies", []); op.setdefault("demands", {}); op.setdefault("target_ids", [])
            op.setdefault("kind", "work"); op.setdefault("visual_phase", "work"); op.setdefault("priority", index)
            if not isinstance(op["dependencies"], list) or any(not isinstance(k, str) for k in op["dependencies"]) or len(set(op["dependencies"])) != len(op["dependencies"]):
                raise ValueError("dependencies must be a list of unique string IDs")
            if op["visual_phase"] not in ("none", "work") or type(op["priority"]) is not int:
                raise ValueError("visual_phase must be none/work; priority must be an integer")
            if set(op["target_ids"]) - target_ids:
                raise ValueError("Operation targets must belong to the selected project's model")
            evidence = op.get("evidence", {})
            if evidence.get("kind") not in ("assumed", "derived", "explicit") or not evidence.get("reason"):
                raise ValueError("Every operation needs evidence.kind (assumed/derived/explicit) and reason")
            evidence.setdefault("basis", "scenario_assumption")
            self.validate_sources(project_id, evidence.get("sources", []), seen)
            if evidence["kind"] == "explicit" and not (evidence.get("sources") or all_sources):
                raise ValueError("Explicit work needs source pointers")
            if "calculation" in op:
                op["duration"] = duration_from_quantity(op["calculation"])
            if type(op.get("duration")) is not int or not 1 <= op["duration"] <= 52560000:
                raise ValueError("duration is an integer number of continuous virtual minutes")
            if any(type(n) is not int for n in op["demands"].values()):
                raise ValueError("Resource demands must be integers")
        groups = {}
        for op in operations:
            for target in op["target_ids"]:
                groups.setdefault(target, []).append(op["id"])
        scenario.update(project_id=project_id, revision=current_revision+1, created_at=now(), model_id=model_id,
            contract="ScenarioPackage", contract_version="0.1.0", planner_version="agent-graph-0.2.0", tick_unit="minute",
            sources=all_sources, assumptions=scenario.get("assumptions", []), seed=scenario.get("seed", 0),
            units=[{"id": k, "name": k, "target_ids": [k], "operation_ids": v, "technology_status": "unapproved"} for k,v in groups.items()],
            unplanned_element_ids=sorted(target_ids - groups.keys()))
        validate_scenario(scenario)
        return self._save(project_id, "construction_scenarios", scenario, request_id, fingerprint)

    def suggest_ifc_scenario(self, project_id, model_id, scenario_id, request_id, variant="base", expected_revision=None):
        from .planner import build_scenario
        model = self.model(project_id, model_id)
        if model["source"]["schema"] == "DocumentSpatialModel":
            raise ValueError("IFC heuristics require an IFC model; create a document-led graph explicitly")
        s = build_scenario(model, variant)
        s.update(id=scenario_id, sources=model["source"].get("sources", []))
        return self.save_scenario(project_id, s, request_id, expected_revision)

    def run_scenario(self, project_id, scenario_id, revision=None, resource_overrides=None):
        scenario = json.loads(encode(self.scenario(project_id, scenario_id, revision)))
        seen = set()
        self.validate_sources(project_id, scenario["sources"], seen)
        for op in scenario["operations"]:
            self.validate_sources(project_id, op["evidence"].get("sources", []), seen)
        if scenario["model_id"]:
            self.validate_sources(project_id, self.model(project_id, scenario["model_id"])["source"].get("sources", []), seen)
        overrides = resource_overrides or {}; resources = {r["id"]: r for r in scenario["resources"]}
        for key, capacity in overrides.items():
            if key not in resources or type(capacity) is not int or not 1 <= capacity <= 100000:
                raise ValueError("Override needs an existing resource and positive integer capacity")
            resources[key]["capacity"] = capacity
        result = SimulationEngine(scenario).run()
        result.update(project_id=project_id, cpm=cpm(scenario), resource_overrides=overrides)
        # Identical input returns the same immutable run; overrides never change the saved scenario.
        return self._save(project_id, "construction_runs", result, "run:" + result["run_id"], canonical_hash(["run", result["run_id"]]))

    def run(self, project_id, run_id):
        r = next((r for r in self._rows(project_id, "construction_runs") if r["run_id"] == run_id), None)
        if not r:
            raise ValueError("Unknown run in selected project")
        return r

    def list_runs(self, project_id, offset=0, limit=40):
        return {"project_id": project_id, **bounded([self.run_summary(r) for r in self._rows(project_id, "construction_runs")], offset, limit)}

    def run_page(self, project_id, run_id, section="schedule", offset=0, limit=40):
        r = self.run(project_id, run_id)
        if section == "schedule":
            items = [{"id": op["id"], "name": op["name"], "duration_minutes": op["duration"], "dependencies": op["dependencies"], "resources": op["demands"], "targets": op["target_ids"],
                      **r["operation_states"][op["id"]], "cpm": r["cpm"]["operations"][op["id"]], "evidence": op["evidence"]} for op in r["scenario"]["operations"]]
        elif section == "events":
            items = r["events"]
        else:
            raise ValueError("section must be schedule or events")
        return {**self.run_summary(r), "section": section, **bounded(items, offset, limit)}
