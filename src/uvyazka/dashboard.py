"""Loopback project view with an explicit, protected native RVT upload route."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import hmac

from .core import Workspace

STATIC = Path(__file__).resolve().parent / "ui"


def make_handler(workspace: Workspace):
    from .construction.rvt_upload import RvtUploads,serve_get
    uploads=RvtUploads(workspace)
    from .intake import ProjectIntake
    intake = ProjectIntake(workspace)
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
                from .semantic_http import serve_get as semantic_get
                if semantic_get(self,workspace,request.path,q):return
                from .intake_http import serve_get as intake_get
                if intake_get(self, intake, uploads.token, request.path, q):return
                from .measurement_http import serve_get as measurement_get
                if measurement_get(self, workspace, uploads.token, request.path, q):return
                from .structure_http import serve_get as structure_get
                if structure_get(self, workspace, uploads.token, request.path, q):return
                from .construction.rvt_catalog_http import serve_get as catalog_get
                if catalog_get(self, workspace, uploads.token, request.path, q):return
                from .construction.viewer_workspace_http import serve_get as viewer_get
                if viewer_get(self,workspace,uploads.token,request.path,q):return
                if serve_get(self,uploads,request.path,q):return
                from .construction.http import serve_route
                if serve_route(self, workspace, request.path, q):
                    return
                static = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"), "/rvt.js": ("rvt.js", "text/javascript"), "/intake.js": ("intake.js", "text/javascript"), "/intake.css": ("intake.css", "text/css"), "/style.css": ("style.css", "text/css")}
                static.update({"/measurements/": ("measurements.html", "text/html"),
                               "/measurements.js": ("measurements.js", "text/javascript"),
                               "/measurement-coordinates.js": ("measurement-coordinates.js", "text/javascript"),
                               "/measurements.css": ("measurements.css", "text/css")})
                static.update({"/structure.js": ("structure.js", "text/javascript"), "/structure.css": ("structure.css", "text/css")})
                static.update({"/search.js": ("search.js", "text/javascript"), "/search.css": ("search.css", "text/css")})
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
                        return self.send(coordination.findings(project_id, q["audit_id"], int(q.get("offset", "0")), int(q.get("limit", "40")), q.get("category") or None))
                    return self.send({"error": "Not found"}, status=404)
                if request.path == "/api/status":
                    return self.send(workspace.project_status(project_id))
                if request.path == "/api/facts":
                    return self.send(workspace.get_project_facts(project_id))
                if request.path == "/api/summary":
                    from .project_summary import ProjectSummary
                    return self.send(ProjectSummary(workspace,project_id).read(q.get("q",""),q.get("group") or None,int(q.get("offset","0")),int(q.get("limit","30"))))
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
            if self.headers.get('Host') not in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}:
                return self.send({'error':'Loopback host required'},status=403)
            request=urlparse(self.path)
            measurement = request.path.startswith('/api/measurements/')
            intake_request = request.path.startswith('/api/intake/')
            viewer_workspace = request.path == '/api/viewer/workspace'
            catalogue = request.path == '/api/rvt/catalog'
            structure = request.path.startswith('/api/structure/')
            semantic = request.path=='/api/semantic/build'
            if request.path!='/api/rvt/upload' and not measurement and not intake_request and not catalogue and not structure and not semantic and not viewer_workspace:
                return self.send({"error": "Use explicit MCP tools for observations"}, status=405)
            origin=self.headers.get('Origin')
            if (origin and origin!='http://'+self.headers['Host']) or not hmac.compare_digest(self.headers.get('X-Uvyazka-Token',''),uploads.token):
                return self.send({'error':'Open the local dashboard before writing'},status=403)
            try:
                if viewer_workspace:
                    from .construction.viewer_workspace_http import serve_post as viewer_post
                    query={k:v[0] for k,v in parse_qs(request.query).items()}
                    return viewer_post(self,workspace,query)
                if semantic:
                    from .semantic_http import serve_post as semantic_post
                    query={k:v[0] for k,v in parse_qs(request.query).items()}
                    return semantic_post(self,workspace,query)
                if structure:
                    from .structure_http import serve_post as structure_post
                    query={k:v[0] for k,v in parse_qs(request.query).items()}
                    return structure_post(self,workspace,request.path,query)
                if catalogue:
                    from .construction.rvt_catalog_http import serve_post as catalog_post
                    query={k:v[0] for k,v in parse_qs(request.query).items()}
                    return catalog_post(self, workspace, query)
                if intake_request:
                    from .intake_http import serve_post as intake_post
                    query={k:v[0] for k,v in parse_qs(request.query).items()}
                    return intake_post(self, intake, request.path, query)
                if measurement:
                    from .measurement_http import serve_post
                    query={k:v[0] for k,v in parse_qs(request.query).items()}
                    return serve_post(self, workspace, request.path, query.get('project_id',''))
                if self.headers.get('Content-Type')!='application/octet-stream':raise ValueError('Raw RVT upload required')
                if self.headers.get('Transfer-Encoding'):raise ValueError('Content-Length required')
                query={k:v[0] for k,v in parse_qs(request.query).items()}
                self.connection.settimeout(60)
                result=uploads.receive(query.get('project_id',''),query.get('filename',''),int(self.headers.get('Content-Length','0')),self.rfile,query.get('simulate')=='1')
                self.send(result,status=202)
            except (ValueError,KeyError,TypeError,OSError) as error:self.send({'error':str(error)},status=400)

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
