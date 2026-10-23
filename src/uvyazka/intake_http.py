"""Protected loopback adapters for the shared intake service."""
import json


def serve_get(handler, intake, token, path, query):
    if not path.startswith("/api/intake/"):
        return False
    if path == "/api/intake/runtime":
        from .folder_picker import PICKER_REVISION, available
        handler.send({"write_token": token, "storage": str(intake.workspace.home),
                      "folder_picker": available(), "folder_mode": "read_in_place",
                      "folder_picker_revision": PICKER_REVISION,
                      "archive_formats": ["zip"], "compute_location": "this_computer"})
    elif path == "/api/intake/jobs":
        handler.send(intake.get(query.get("intake_id"), query.get("project_id"), int(query.get("limit","10"))))
    else:
        handler.send({"error": "Unknown intake route"}, status=404)
    return True


def serve_post(handler, intake, path, query):
    """Caller validates Host, Origin and session token before invoking this adapter."""
    if handler.headers.get("Transfer-Encoding"):
        raise ValueError("Content-Length required")
    length = int(handler.headers.get("Content-Length", "0"))
    handler.connection.settimeout(120)
    if path in {"/api/intake/file", "/api/intake/archive"}:
        if handler.headers.get("Content-Type") != "application/octet-stream":
            raise ValueError("Raw file bytes required")
        if path.endswith("/file"):
            result = intake.receive_file(query["intake_id"], query["path"], length, handler.rfile)
        else:
            result = intake.receive_archive(query["intake_id"], length, handler.rfile)
    else:
        if handler.headers.get("Content-Type", "").split(";")[0] != "application/json" or not 2 <= length <= 16*1024*1024:
            raise ValueError("JSON body required (up to 16 MiB of manifest metadata)")
        raw = handler.rfile.read(length)
        if len(raw) != length:
            raise ValueError("Incomplete JSON request")
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError("JSON object required")
        if path == "/api/intake/pick-folder":
            from .folder_picker import select_folder
            result = select_folder(body.get("initial_path", ""))
        elif path == "/api/intake/folder":
            result = intake.import_folder(body["source_root"], body.get("name",""), body.get("project_id") or None)
        elif path == "/api/intake/start":
            result = intake.begin_upload(body["mode"], body["name"], body.get("files"), body.get("project_id") or None)
        elif path == "/api/intake/finish":
            result = intake.finish_folder(body["intake_id"])
        elif path == "/api/intake/resume":
            retry = body.get("retry_failed",False)
            if type(retry) is not bool:
                raise ValueError("retry_failed must be boolean")
            intake.start(body["intake_id"], retry)
            result = intake.get(body["intake_id"])
        else:
            raise ValueError("Unknown intake action")
    handler.send(result, status=202)
