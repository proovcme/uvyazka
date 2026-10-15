"""Synthetic, clearly identified demo. It contains no real project data."""
from pathlib import Path

from .core import Workspace
from .ingest import scan


def create_demo(workspace: Workspace) -> dict:
    root = workspace.home / "demo-sources"
    root.mkdir(parents=True, exist_ok=True)
    for project_id, name, amount in [("demo-a", "Учебный объект А", "12"), ("demo-b", "Учебный объект Б", "8")]:
        sources = root / project_id
        sources.mkdir(exist_ok=True)
        # A repeated demo command must not overwrite a user's local exercise
        # or change timestamps and invalidate already recorded source pointers.
        for filename, content in {
            "project.txt": "СИНТЕТИЧЕСКИЙ ПРИМЕР.\nПлощадь участка: " + amount + " м2.\nБетон В25, чистый объём: 4 м3.\nКоличество колонн: 6 шт.\n",
            "quantities.csv": "position;name;quantity;unit\n1;Площадь участка;" + amount + ";m2\n2;Бетон В25;4.2;m3\n",
        }.items():
            target = sources / filename
            if not target.exists():
                target.write_text(content, encoding="utf-8")
        try:
            workspace.project(project_id)
        except ValueError:
            workspace.create_project(project_id, name, sources, "Синтетические данные")
        if workspace.get_project_facts(project_id)["facts"]:
            continue
        scan(workspace, project_id)
        docs = {d["relative_path"]: d for d in workspace.find_documents(project_id)["documents"]}
        a, b = docs["project.txt"], docs["quantities.csv"]
        observations = []
        for obs_id, value, raw, doc, block in [("area-design", amount, amount, a, 2), ("area-bill", amount, amount, b, 2), ("concrete-design", "4", "4 м3", a, 3), ("concrete-bill", "4.2", "4.2", b, 3)]:
            area = obs_id.startswith("area")
            observations.append({"id": obs_id, "name": "Площадь участка" if area else "Бетон В25: сопоставление объёма", "group": "tep" if area else "quantities", "value": value,
                "raw_value": raw, "unit": "m2" if area else "m3", "basis": "same_scope", "entity": "site" if area else "concrete", "property": "area" if area else "volume", "revision_set": "synthetic-1", "specification": None if area else "B25",
                "sources": [{"doc_id": doc["doc_id"], "sha256": doc["sha256"], "page_number": block}], "note": "Synthetic example; semantic scope must be checked on real data"})
        workspace.record_observations(project_id, observations, "synthetic-initial-v1")
        workspace.compare_facts(project_id, "area-design", "area-bill")
        workspace.compare_facts(project_id, "concrete-design", "concrete-bill")
    return workspace.list_projects()
