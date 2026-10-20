"""View-scoped PDF measurements. The client model supplies all interpretation.

Coordinates are unrotated, top-left PDF points, never screenshot pixels.
All records and revisions live in the existing project SQLite database.
"""
from __future__ import annotations

import hashlib
import json
import math
import re

from .core import connection, encode, now


SQL = """
create table if not exists drawing_records(
 kind text not null, id text not null, revision integer not null,
 payload text not null, primary key(kind,id,revision));
create table if not exists drawing_requests(
 request_id text primary key, fingerprint text not null, result text not null);
"""
COORDINATES = "pdf_unrotated_top_left_points"


def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Coordinates and lengths must be finite numbers")
    return float(value)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,96}", value):
        raise ValueError("ID must contain 1–96 ASCII letters, digits, _ or -")
    return value


def text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        raise ValueError(name + " must be nonempty text <=2000 characters")
    return value


def point(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError("Point requires [x,y]")
    return [finite(n) for n in value]


def rectangle(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("Region requires [x0,y0,x1,y1]")
    box = [finite(n) for n in value]
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError("Region must have positive width and height")
    return box


def inside(p, box):
    return box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]


def cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def intersects(a, b, c, d):
    def on(p, q, r):
        return abs(cross(p, q, r)) <= 1e-9 and all(
            min(p[k], q[k])-1e-9 <= r[k] <= max(p[k], q[k])+1e-9 for k in (0, 1))
    return (cross(a, b, c)*cross(a, b, d) < 0 and cross(c, d, a)*cross(c, d, b) < 0
            or on(a, b, c) or on(a, b, d) or on(c, d, a) or on(c, d, b))


def geometry(kind, points, box):
    if kind not in {"length", "area"}:
        raise ValueError("kind must be length or area; holes and curves are not supported")
    if not isinstance(points, list) or not 2 <= len(points) <= 500:
        raise ValueError("Supply 2–500 vertices")
    vertices = [point(p) for p in points]
    if kind == "area" and vertices[-1] == vertices[0]:
        vertices.pop()
    if any(not inside(p, box) for p in vertices):
        raise ValueError("Measurement crosses its view region")
    if len(set(map(tuple, vertices))) != len(vertices):
        raise ValueError("Repeated vertices are ambiguous")
    segments = list(zip(vertices, vertices[1:]))
    if kind == "area":
        if len(vertices) < 3:
            raise ValueError("Area requires at least three vertices")
        segments.append((vertices[-1], vertices[0]))
        for i, (a, b) in enumerate(segments):
            # Reject retraced adjacent edges too.
            c = vertices[(i+2) % len(vertices)]
            if abs(cross(a, b, c)) <= 1e-9 and sum(
                    (b[k]-a[k])*(c[k]-b[k]) for k in (0, 1)) < 0:
                raise ValueError("Polygon retraces an edge")
            for j in range(i+1, len(segments)):
                if j == i+1 or (i == 0 and j == len(segments)-1):
                    continue
                if intersects(a, b, *segments[j]):
                    raise ValueError("Self-intersecting or touching polygon")
        area = abs(sum(a[0]*b[1]-b[0]*a[1] for a, b in segments))/2
        if area <= 1e-9:
            raise ValueError("Degenerate polygon")
    else:
        area = None
    length = sum(math.dist(a, b) for a, b in segments)
    if length <= 1e-9:
        raise ValueError("Degenerate measurement")
    return vertices, length, area


class Measurements:
    def __init__(self, workspace, project_id, actor="agent"):
        if actor not in {"agent", "user"}:
            raise ValueError("Unknown measurement actor")
        self.actor = actor
        self.workspace, self.project_id = workspace, project_id
        self.path = workspace.db_path(project_id)
        with connection(self.path) as db:
            db.executescript(SQL)

    @staticmethod
    def current(db, kind, key, required=True):
        row = db.execute("select payload from drawing_records where kind=? and id=? order by revision desc limit 1",
                         (kind, key)).fetchone()
        if row:
            return json.loads(row[0])
        if required:
            raise ValueError("Unknown " + kind + ": " + key)
        return None

    def append(self, db, kind, value):
        value["created_by"] = self.actor
        db.execute("insert into drawing_records values(?,?,?,?)",
                   (kind, value["id"], value["revision"], encode(value)))

    def mutate(self, request_id, payload, action):
        identifier(request_id)
        serialized = encode(payload if self.actor == "agent" else [self.actor, payload]).encode()
        if len(serialized) > 1024*1024:
            raise ValueError("Mutation payload exceeds 1 MiB")
        fingerprint = hashlib.sha256(serialized).hexdigest()
        with connection(self.path) as db:
            db.execute("begin immediate")
            old = db.execute("select fingerprint,result from drawing_requests where request_id=?", (request_id,)).fetchone()
            if old:
                if old[0] != fingerprint:
                    raise ValueError("request_id reused with different arguments")
                return json.loads(old[1])
            result = {"project_id": self.project_id, **action(db)}
            db.execute("insert into drawing_requests values(?,?,?)", (request_id, fingerprint, encode(result)))
            db.execute("insert into events(created_at,kind,payload) values(?,?,?)",
                       (now(), "drawing_measurement", encode({"request_id": request_id, "action": payload[0]})))
            return result

    def pdf(self, doc_id, sha256):
        record, path = self.workspace.source_record(self.project_id, doc_id)
        if record["sha256"] != sha256 or path.suffix.lower() != ".pdf":
            raise ValueError("Choose the registered current PDF hash")
        if not path.is_file() or not 0 < path.stat().st_size <= 64*1024*1024:
            raise ValueError("PDF unavailable or exceeds 64 MiB")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != sha256:
            raise ValueError("Source changed; scan and review the new revision")
        try:
            import pymupdf
        except ImportError as exc:
            raise ValueError("Install uvyazka[readers] for PDF measurements") from exc
        pdf = pymupdf.open(stream=data, filetype="pdf")
        if pdf.needs_pass:
            pdf.close()
            raise ValueError("Encrypted PDF requires a readable source")
        return pdf

    @staticmethod
    def page(pdf, page_number):
        if type(page_number) is not int or not 1 <= page_number <= len(pdf):
            raise ValueError("Invalid 1-based PDF page")
        page = pdf[page_number-1]
        rotation = page.rotation
        page.set_rotation(0)  # In-memory rendering frame; never saves the PDF.
        return page, rotation

    def inspect(self, doc_id, sha256, page_number=1, region=None, offset=0, limit=100, section="text"):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("Invalid offset/limit")
        if section not in {"text", "vectors"}:
            raise ValueError("section must be text or vectors")
        with self.pdf(doc_id, sha256) as pdf:
            import pymupdf
            page, rotation = self.page(pdf, page_number)
            box = rectangle(region or list(page.rect))
            if not inside(box[:2], list(page.rect)) or not inside(box[2:], list(page.rect)):
                raise ValueError("Region outside page")
            if section == "text":
                words = page.get_text("words", clip=box)
                rows = [{"bounds": list(w[:4]), "text": w[4]} for w in words[offset:offset+limit]]
                total = len(words)
            else:
                def plain(value):
                    if isinstance(value, (pymupdf.Point, pymupdf.Rect, pymupdf.Quad, list, tuple)):
                        return [plain(v) for v in value]
                    return value
                rows, total = [], 0
                for path_index, path in enumerate(page.get_drawings()):
                    bounds = path["rect"]
                    if bounds.x1 < box[0] or bounds.x0 > box[2] or bounds.y1 < box[1] or bounds.y0 > box[3]:
                        continue
                    for item_index, item in enumerate(path["items"]):
                        if offset <= total < offset+limit:
                            rows.append({"path_index": path_index, "item_index": item_index,
                                         "primitive": plain(item), "path_bounds": list(path["rect"]),
                                         "stroke": plain(path.get("color")), "fill": plain(path.get("fill")),
                                         "width": path.get("width"), "closed": path.get("closePath")})
                        total += 1
            return {"project_id": self.project_id, "doc_id": doc_id, "sha256": sha256,
                    "page_number": page_number, "coordinate_system": COORDINATES,
                    "page_bounds": list(page.rect), "original_rotation": rotation, "region": box,
                    "section": section, section: rows, "total_items": total,
                    "next_offset": offset+limit if offset+limit < total else None,
                    "ocr": False, "note": "No automatic view detection. Use render_drawing_measurements to inspect the page."}

    def save_view(self, view, expected_revision, request_id):
        allowed = {"id", "doc_id", "sha256", "page_number", "sheet_label", "name", "kind", "region",
                   "orientation_degrees", "measurement_basis", "reason"}
        if set(view)-allowed:
            raise ValueError("Unknown view fields: " + str(sorted(set(view)-allowed)))
        key = identifier(view.get("id"))
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("expected_revision: 0 for new view, current revision for update")
        def action(db):
            old = self.current(db, "view", key, False)
            if (old["revision"] if old else 0) != expected_revision:
                raise ValueError("View revision conflict; reload context")
            box = rectangle(view.get("region"))
            with self.pdf(view["doc_id"], view["sha256"]) as pdf:
                page, rotation = self.page(pdf, view["page_number"])
                if not inside(box[:2], list(page.rect)) or not inside(box[2:], list(page.rect)):
                    raise ValueError("View outside page")
            item = {**view, "region": box, "name": text(view.get("name"), "name"),
                    "kind": text(view.get("kind"), "kind"), "reason": text(view.get("reason"), "reason"),
                    "measurement_basis": text(view.get("measurement_basis"), "measurement_basis"),
                    "orientation_degrees": finite(view.get("orientation_degrees", 0)),
                    "revision": expected_revision+1, "coordinate_system": COORDINATES,
                    "original_page_rotation": rotation, "created_at": now(),
                    "interpretation_status": self.actor + "_proposed"}
            self.append(db, "view", item)
            return {"view": item, "effect": "New view revision requires its own calibration. Previous results remain in history."}
        return self.mutate(request_id, ["save_view", view, expected_revision], action)

    def fresh_view(self, view):
        # Verify actual bytes, not only file dates or the last indexed hash.
        with self.pdf(view["doc_id"], view["sha256"]) as pdf:
            self.page(pdf, view["page_number"])

    def calibrate(self, view_id, expected_view_revision, expected_calibration_revision,
                  points, length_m, basis, request_id):
        def action(db):
            view = self.current(db, "view", view_id)
            if view["revision"] != expected_view_revision:
                raise ValueError("View revision conflict")
            self.fresh_view(view)
            old = self.current(db, "calibration", view_id, False)
            if (old["revision"] if old else 0) != expected_calibration_revision:
                raise ValueError("Calibration revision conflict")
            if not isinstance(points, list) or len(points) != 2:
                raise ValueError("Calibration requires exactly two control points")
            vertices, length, _ = geometry("length", points, view["region"])
            real = finite(length_m)
            if real <= 0:
                raise ValueError("Control length must be positive metres")
            if not math.isfinite(real/length) or real/length <= 0:
                raise ValueError("Invalid calibration factor")
            value = {"id": view_id, "revision": expected_calibration_revision+1,
                     "view_revision": view["revision"], "points": vertices, "length_m": real,
                     "metres_per_point": real/length, "basis": text(basis, "basis"),
                     "status": self.actor + "_proposed", "method": "uniform_two_point",
                     "created_at": now(), "limitations": "Uniform planar scale only; no distortion or broken-view correction."}
            self.append(db, "calibration", value)
            return {"calibration": value, "effect": "Dependent measurements require explicit recalculation; historical values are retained."}
        if any(type(r) is not int or r < 0 for r in [expected_view_revision, expected_calibration_revision]):
            raise ValueError("Expected revisions must be nonnegative integers")
        return self.mutate(request_id, ["calibrate", view_id, expected_view_revision,
                           expected_calibration_revision, points, length_m, basis], action)

    def pair(self, db, view_id, view_revision, calibration_revision):
        view = self.current(db, "view", view_id)
        cal = self.current(db, "calibration", view_id)
        if (view["revision"], cal["revision"], cal["view_revision"]) != (view_revision, calibration_revision, view_revision):
            raise ValueError("View/calibration changed; reload context")
        self.fresh_view(view)
        return view, cal

    @staticmethod
    def calculated(item, view, cal, revision, reason):
        item = {k: v for k, v in item.items() if k != "review"}
        vertices, perimeter, area = geometry(item["kind"], item["points"], view["region"])
        scale = cal["metres_per_point"]
        value = perimeter*scale if area is None else area*scale*scale
        if not math.isfinite(value) or not math.isfinite(perimeter*scale):
            raise ValueError("Measurement overflow")
        return {**item, "id": identifier(item.get("id")), "points": vertices,
                "name": text(item.get("name"), "name"), "basis": text(item.get("basis"), "basis"),
                "revision": revision, "view_id": view["id"], "view_revision": view["revision"],
                "calibration_revision": cal["revision"], "source": {
                    "doc_id": view["doc_id"], "sha256": view["sha256"], "page_number": view["page_number"]},
                "value": value, "unit": "m" if area is None else "m2", "perimeter_m": perimeter*scale,
                "status": "calculated_unreviewed", "method": "polyline_v1" if area is None else "shoelace_v1",
                "reason": text(reason, "reason"), "created_at": now()}

    def measure(self, view_id, view_revision, calibration_revision, items, request_id):
        if not isinstance(items, list) or not 1 <= len(items) <= 40:
            raise ValueError("Batch requires 1–40 measurements")
        def action(db):
            view, cal = self.pair(db, view_id, view_revision, calibration_revision)
            results, seen = [], set()
            for item in items:
                if set(item)-{"id", "kind", "points", "name", "basis", "expected_revision", "reason", "entity_ref"}:
                    raise ValueError("Unknown measurement fields")
                key = identifier(item.get("id"))
                if key in seen:
                    raise ValueError("Duplicate ID within batch")
                seen.add(key)
                old = self.current(db, "measurement", key, False)
                expected = item.get("expected_revision", 0)
                if type(expected) is not int or expected != (old["revision"] if old else 0):
                    raise ValueError("Measurement revision conflict")
                if old and old["view_id"] != view_id:
                    raise ValueError("Measurement cannot be silently moved to another view")
                result = self.calculated({k: v for k, v in item.items() if k != "expected_revision"},
                                         view, cal, expected+1, item.get("reason"))
                self.append(db, "measurement", result)
                results.append(result)
            return {"measurements": results, "atomic": True}
        return self.mutate(request_id, ["measure", view_id, view_revision, calibration_revision, items], action)

    def recalculate(self, view_id, view_revision, calibration_revision, items, reason, request_id):
        if not isinstance(items, list) or not 1 <= len(items) <= 40:
            raise ValueError("Specify 1–40 {id,expected_revision} records")
        def action(db):
            view, cal = self.pair(db, view_id, view_revision, calibration_revision)
            results, seen = [], set()
            for item in items:
                if set(item) != {"id", "expected_revision"} or item["id"] in seen:
                    raise ValueError("Invalid or duplicate recalculation target")
                seen.add(item["id"])
                old = self.current(db, "measurement", item["id"])
                if old["view_id"] != view_id or old["revision"] != item["expected_revision"]:
                    raise ValueError("Measurement scope/revision conflict")
                if old["view_revision"] != view_revision:
                    raise ValueError("View/source changed: re-inspect geometry and submit a corrected measurement")
                if old["calibration_revision"] == calibration_revision:
                    raise ValueError("Measurement already uses this calibration")
                result = self.calculated(old, view, cal, old["revision"]+1, reason)
                self.append(db, "measurement", result)
                results.append(result)
            return {"measurements": results, "atomic": True}
        return self.mutate(request_id, ["recalculate", view_id, view_revision, calibration_revision, items, reason], action)

    def review(self, items, request_id):
        if not isinstance(items, list) or not 1 <= len(items) <= 40:
            raise ValueError("Specify 1–40 review records")
        def action(db):
            results, seen = [], set()
            for item in items:
                if set(item) != {"id", "expected_revision", "verdict", "note"} or item["id"] in seen:
                    raise ValueError("Review requires distinct id,expected_revision,verdict,note")
                seen.add(item["id"])
                old = self.current(db, "measurement", item["id"])
                if old["revision"] != item["expected_revision"]:
                    raise ValueError("Measurement revision conflict")
                self.pair(db, old["view_id"], old["view_revision"], old["calibration_revision"])
                if item["verdict"] not in {"geometry_checked", "question"}:
                    raise ValueError("verdict must be geometry_checked or question; no human approval impersonation")
                result = {**old, "revision": old["revision"]+1, "created_at": now(),
                          "status": "agent_checked" if item["verdict"] == "geometry_checked" else "question",
                          "review": {"actor": "agent", "verdict": item["verdict"],
                                     "note": text(item["note"], "note"), "based_on_revision": old["revision"]}}
                self.append(db, "measurement", result)
                results.append(result)
            return {"measurements": results, "atomic": True,
                    "note": "Agent-reported review is not independent or human engineering approval."}
        return self.mutate(request_id, ["review", items], action)

    def context(self, kind="view", view_id=None, record_id=None, history=False, offset=0, limit=40):
        if (kind not in {"view", "calibration", "measurement"} or type(offset) is not int
                or offset < 0 or type(limit) is not int or not 1 <= limit <= 100 or type(history) is not bool):
            raise ValueError("Invalid kind or pagination")
        with connection(self.path, readonly=True) as db:
            where = """ from drawing_records r where kind=? and
                (? or revision=(select max(revision) from drawing_records s where s.kind=r.kind and s.id=r.id))
                and (? is null or id=?)
                and (? is null or (case when kind='measurement' then json_extract(payload,'$.view_id') else id end)=?)"""
            args = (kind, history, record_id, record_id, view_id, view_id)
            total = db.execute("select count(*)"+where, args).fetchone()[0]
            selected = [json.loads(r[0]) for r in db.execute(
                "select payload"+where+" order by id,revision limit ? offset ?", (*args, limit, offset))]
            states = {}
            for item in selected:
                key = item.get("view_id") if kind == "measurement" else item["id"]
                view = self.current(db, "view", key)
                referenced_revision = item["revision"] if kind == "view" else item["view_revision"]
                source_view = json.loads(db.execute(
                    "select payload from drawing_records where kind='view' and id=? and revision=?",
                    (key, referenced_revision)).fetchone()[0])
                cal = self.current(db, "calibration", key, False)
                reasons = []
                source_key = (source_view["doc_id"], source_view["sha256"])
                if source_key not in states:
                    try:
                        self.fresh_view(source_view)
                        states[source_key] = "hash_matches"
                    except (ValueError, OSError) as exc:
                        states[source_key] = str(exc)
                if states[source_key] != "hash_matches":
                    reasons.append("source_changed_or_unavailable")
                if referenced_revision != view["revision"]:
                    reasons.append("view_revision_changed")
                if kind == "measurement" and (not cal or item["calibration_revision"] != cal["revision"]):
                    reasons.append("calibration_changed")
                if kind == "calibration" and cal and item["revision"] != cal["revision"]:
                    reasons.append("calibration_superseded")
                if kind == "measurement":
                    latest = self.current(db, kind, item["id"])
                    if latest["revision"] != item["revision"]:
                        reasons.append("measurement_superseded")
                item["stale_reasons"] = reasons
                item["source_check"] = states[source_key]
            counts = {r[0]: r[1] for r in db.execute(
                "select kind,count(distinct id) from drawing_records group by kind")}
        return {"project_id": self.project_id, "kind": kind, "items": selected, "total": total,
                "next_offset": offset+limit if offset+limit < total else None, "counts": counts,
                "coverage": "Counts cover registered records only; undiscovered views and unread sheets are not certified.",
                "next": "Inspect source and view; calibrate; measure; render overlay; inspect history after changes."}

    def render(self, doc_id, sha256, page_number=1, view_id=None, measurement_ids=None):
        import pymupdf
        with self.pdf(doc_id, sha256) as pdf, connection(self.path, readonly=True) as db:
            page, _ = self.page(pdf, page_number)
            box = list(page.rect)
            rendered = []
            if view_id:
                view = self.current(db, "view", view_id)
                if (view["doc_id"], view["sha256"], view["page_number"]) != (doc_id, sha256, page_number):
                    raise ValueError("View belongs to a different source/page")
                box = view["region"]
                cal = self.current(db, "calibration", view_id, False)
                ids = measurement_ids or []
                if len(ids) > 40 or len(set(ids)) != len(ids):
                    raise ValueError("Choose at most 40 distinct measurement IDs")
                for key in ids:
                    item = self.current(db, "measurement", key)
                    if item["view_id"] != view_id or item["view_revision"] != view["revision"]:
                        raise ValueError("Measurement is from another view revision")
                    stale = not cal or item["calibration_revision"] != cal["revision"]
                    points = [pymupdf.Point(p) for p in item["points"]]
                    page.draw_polyline(points, closePath=item["kind"] == "area",
                                       color=(.9, .15, .1) if stale else (1, .6, 0), width=1.2)
                    for p in points:
                        page.draw_circle(p, 1.6, color=(.1, .2, .3), fill=(1, .7, .1))
                    label_key = key if len(key) <= 18 else key[:18] + "..."
                    label = f"{label_key}: {item['value']:.6g} {item['unit']}" + (" STALE" if stale else " UNREVIEWED")
                    page.insert_text(points[0]+(2, -3), label, fontsize=7, color=(.15, .2, .25))
                    rendered.append({"id": key, "revision": item["revision"], "stale": stale})
                if cal and cal["view_revision"] == view["revision"]:
                    control = [pymupdf.Point(p) for p in cal["points"]]
                    page.draw_line(*control, color=(0, .45, .75), width=1.2)
                    page.insert_text(control[0]+(2, 12),
                        f"Control {cal['length_m']:.6g} m / calibration {cal['revision']} / {cal.get('created_by', 'agent').upper()}",
                        fontsize=7, color=(0, .35, .65))
            elif measurement_ids:
                raise ValueError("Select a view to overlay measurements")
            scale = min(2, 1800/max(box[2]-box[0], box[3]-box[1]))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=pymupdf.Rect(box), alpha=False)
            metadata = {"project_id": self.project_id, "doc_id": doc_id, "sha256": sha256,
                        "page_number": page_number, "view_id": view_id, "region": box,
                        "coordinate_system": COORDINATES, "rendered": rendered,
                        "pixel_origin_page_points": [pix.x/scale, pix.y/scale], "pixels_per_point": scale,
                        "pixel_size": [pix.width, pix.height],
                        "note": "Amber: unreviewed measurement; red: stale calibration; blue: control dimension. Original PDF unchanged."}
            return metadata, pix.tobytes("png")
