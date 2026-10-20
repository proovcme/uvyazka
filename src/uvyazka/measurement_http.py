"""Explicit loopback routes over the same measurement store used by MCP."""
import base64
import json

from .measurements import Measurements


def serve_get(handler, workspace, token, path, query):
    if not path.startswith("/api/measurements/"):
        return False
    project = query.get("project_id", "")
    workspace.project(project)
    key = path.rsplit("/", 1)[-1]
    if key == "runtime":
        handler.send({"write_token": token, "project_id": project, "storage": "project_sqlite",
                      "source_limit_bytes": 64*1024*1024})
        return True
    store = Measurements(workspace, project)
    if key == "context":
        result = store.context(query.get("kind", "view"), query.get("view_id"),
                               query.get("record_id"), query.get("history") == "1",
                               int(query.get("offset", "0")), int(query.get("limit", "40")))
    elif key == "render":
        meta, png = store.render(query["doc_id"], query["sha256"], int(query.get("page", "1")),
                                 query.get("view_id"), query.get("measurement_ids", "").split(",")
                                 if query.get("measurement_ids") else None)
        result = {"metadata": meta, "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}
    else:
        handler.send({"error": "Unknown measurement route"}, status=404)
        return True
    handler.send(result)
    return True


def serve_post(handler, workspace, path, project):
    """Caller must validate loopback host, Origin and the session write token."""
    methods = {"view": "save_view", "calibration": "calibrate",
               "measure": "measure", "recalculate": "recalculate"}
    key = path.rsplit("/", 1)[-1]
    if key not in methods:
        raise ValueError("Unknown measurement action")
    if handler.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
        raise ValueError("JSON required")
    if handler.headers.get("Transfer-Encoding"):
        raise ValueError("Content-Length required")
    length = int(handler.headers.get("Content-Length", "0"))
    if not 2 <= length <= 1024*1024:
        raise ValueError("JSON body must be between 2 bytes and 1 MiB")
    handler.connection.settimeout(15)
    raw = handler.rfile.read(length)
    if len(raw) != length:
        raise ValueError("Incomplete request body")
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise ValueError("Expected an object")
    store = Measurements(workspace, project, actor="user")
    # Explicit allowlist, never dynamic access to arbitrary store attributes.
    handler.send(getattr(store, methods[key])(**body))
