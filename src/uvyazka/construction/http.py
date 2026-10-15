"""Read-only browser/download routes over the same construction store as MCP."""
import csv
import io
import mimetypes
from pathlib import Path

from .planning import Planning


def serve_route(handler, workspace, path, query):
    if path.startswith("/simulation/"):
        root = (Path(__file__).resolve().parents[1] / "viewer").resolve()
        relative = path[len("/simulation/"):] or "index.html"
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            handler.send({"error": "Viewer resource not found"}, status=404)
        else:
            handler.send(target.read_bytes(), mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        return True
    if not path.startswith("/api/construction/"):
        return False
    p = Planning(workspace); project = query.get("project_id", ""); workspace.project(project)
    offset = int(query.get("offset", "0")); limit = int(query.get("limit", "200"))
    key = path.rsplit("/", 1)[-1]
    if key == "models":
        handler.send(p.list_models(project, offset, limit))
    elif key == "scenarios":
        handler.send(p.list_scenarios(project, offset, limit))
    elif key == "runs":
        handler.send(p.list_runs(project, offset, limit))
    elif key == "scenario":
        revision = int(query["revision"]) if query.get("revision") else None
        handler.send(p.scenario_page(project, query["scenario_id"], revision, offset, limit))
    elif key == "run":
        handler.send(p.run(project, query["run_id"]))
    elif key == "model":
        handler.send(p.model(project, query["model_id"]))
    elif key == "geometry.bin":
        handler.send((p.model_path(project, query["model_id"]) / "geometry.bin").read_bytes(), "application/octet-stream")
    elif key == "schedule.csv":
        run = p.run(project, query["run_id"])
        output = io.StringIO(newline=""); writer = csv.writer(output)
        writer.writerow(["id", "name", "start_minute", "finish_minute", "duration_minutes", "dependencies", "resources", "evidence"])
        def safe(value):
            value = str(value)
            return "'"+value if value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value
        for op in run["scenario"]["operations"]:
            state = run["operation_states"][op["id"]]
            writer.writerow([safe(op["id"]), safe(op["name"]), state["start"], state["finish"], op["duration"],
                             safe(";".join(op["dependencies"])), safe(str(op["demands"])), safe(op["evidence"]["reason"])])
        handler.send(output.getvalue().encode("utf-8-sig"), "text/csv; charset=utf-8")
    else:
        handler.send({"error": "Construction route not found"}, status=404)
    return True
