"""Loopback-only read view over the same project store used by MCP."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json

from .core import Workspace

STATIC = Path(__file__).resolve().parent / "ui"


def make_handler(workspace: Workspace):
    class Handler(BaseHTTPRequestHandler):
        def send(self, data, content_type="application/json; charset=utf-8", status=200):
            if isinstance(data, (dict, list)):
                data = json.dumps(data, ensure_ascii=False).encode("utf-8")
            elif isinstance(data, str):
                data = data.encode("utf-8")
            self.send_response(status)
            for key, value in {"Content-Type": content_type, "Content-Length": str(len(data)), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'self'; frame-ancestors 'none'"}.items():
                self.send_header(key, value)
            self.end_headers(); self.wfile.write(data)

        def do_GET(self):
            if self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
                return self.send({"error": "Loopback host required"}, status=403)
            request = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(request.query).items()}
            try:
                from .construction.http import serve_route
                if serve_route(self, workspace, request.path, q):
                    return
                static = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"), "/style.css": ("style.css", "text/css")}
                if request.path in static:
                    name, mime = static[request.path]
                    return self.send((STATIC / name).read_bytes(), mime + "; charset=utf-8")
                if request.path == "/api/projects":
                    return self.send(workspace.list_projects())
                project_id = q.get("project_id", ""); workspace.project(project_id)
                if request.path.startswith("/api/coordination/"):
                    from .coordination import Coordination
                    coordination = Coordination(workspace)
                    if request.path.endswith("/audits"):
                        return self.send(coordination.audits(project_id))
                    if request.path.endswith("/issues"):
                        return self.send(coordination.findings(project_id, q["audit_id"], int(q.get("offset", "0")), int(q.get("limit", "40"))))
                    return self.send({"error": "Not found"}, status=404)
                if request.path == "/api/status":
                    return self.send(workspace.project_status(project_id))
                if request.path == "/api/facts":
                    return self.send(workspace.get_project_facts(project_id))
                if request.path == "/api/checks":
                    return self.send(workspace.get_reconciliation(project_id))
                if request.path == "/api/documents":
                    return self.send(workspace.find_documents(project_id, q.get("q", ""), 30, int(q.get("offset", "0"))))
                if request.path == "/api/search":
                    return self.send(workspace.search_project(project_id, q.get("q", "")))
                if request.path == "/api/source":
                    return self.send(workspace.read_evidence(project_id, q["doc_id"], int(q.get("page", "1")), int(q.get("offset", "0")), 6000, q.get("sha256"), q.get("parser_revision")))
                if request.path in {"/api/pdf", "/api/page-image"}:
                    doc, path = workspace.source_record(project_id, q["doc_id"])
                    if doc["extension"] != ".pdf":
                        raise ValueError("Only PDF has a page image")
                    if q.get("sha256") != doc["sha256"] or workspace.source_state(project_id, q["doc_id"], full_hash=True)["status"] != "content_hash_matches":
                        return self.send({"error": "Source changed; original no longer matches this observation"}, status=409)
                    if request.path == "/api/pdf":
                        return self.send(path.read_bytes(), "application/pdf")
                    import pymupdf
                    with pymupdf.open(path) as pdf:
                        page = int(q.get("page", "1"))
                        if not 1 <= page <= len(pdf):
                            raise ValueError("Unknown PDF page")
                        p = pdf[page - 1]; scale = min(2, 2000 / max(p.rect.width, p.rect.height))
                        return self.send(p.get_pixmap(matrix=pymupdf.Matrix(scale, scale)).tobytes("png"), "image/png")
                self.send({"error": "Not found"}, status=404)
            except (KeyError, ValueError) as exc:
                self.send({"error": str(exc)}, status=400)
            except Exception as exc:
                self.send({"error": "Unable to read project: " + str(exc)}, status=500)

        def do_POST(self):
            self.send({"error": "Dashboard is read-only; use explicit MCP tools for observations"}, status=405)

        def log_message(self, *args):
            pass
    return Handler


def serve(workspace: Workspace, port: int = 8772):
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(workspace))
    print(f"Увязка: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
