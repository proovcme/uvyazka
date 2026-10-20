"""Project-scoped SQLite memory; source files are opened only for reading."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from typing import Any
from uuid import uuid4, uuid5, NAMESPACE_URL

SCHEMA = "uvyazka.project.v1"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def normalized(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value)).strip()


def default_home() -> Path:
    if os.environ.get("UVYAZKA_HOME"):
        return Path(os.environ["UVYAZKA_HOME"]).expanduser().resolve()
    return (Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "uvyazka").resolve()


@contextmanager
def connection(path: Path, *, readonly: bool = False):
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30) if readonly else sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("pragma foreign_keys=on")
    db.create_function("casefold", 1, lambda s: str(s or "").casefold(), deterministic=True)
    try:
        with db:
            yield db
    finally:
        db.close()


PROJECT_SQL = """
create table metadata(key text primary key,value text not null);
create table documents(doc_id text primary key,relative_path text unique not null,
 extension text not null,sha256 text,size_bytes integer,mtime_ns integer,
 page_count integer,index_status text not null,parser_revision text,error text,
 revision_status text not null default 'unconfirmed');
create table document_versions(doc_id text not null,sha256 text not null,
 parser_revision text not null,recorded_at text not null,
 primary key(doc_id,sha256,parser_revision));
create table pages(doc_id text not null,sha256 text not null,parser_revision text not null,page_number integer not null,
 text text not null,locator text not null,low_text integer not null,
 primary key(doc_id,sha256,parser_revision,page_number));
create table chunks(chunk_id integer primary key,doc_id text not null,
 sha256 text not null,page_number integer not null,part integer not null,text text not null);
create virtual table chunk_fts using fts5(text,tokenize='unicode61 remove_diacritics 2');
create table facts(fact_id text not null,revision integer not null,fact_group text not null,
 payload text not null,active integer not null,primary key(fact_id,revision));
create unique index active_fact on facts(fact_id) where active=1;
create table checks(check_id text primary key,status text not null,payload text not null);
create table events(event_id integer primary key,created_at text not null,kind text not null,payload text not null);
create table requests(request_id text primary key,payload_hash text not null,result text not null);
create index chunk_location on chunks(doc_id,page_number);
"""


class Workspace:
    def __init__(self, home: str | Path | None = None):
        self.home = Path(home).expanduser().resolve() if home else default_home()
        self.home.mkdir(parents=True, exist_ok=True)
        self.registry = self.home / "registry.sqlite3"
        with connection(self.registry) as db:
            db.execute("create table if not exists projects(project_id text primary key,name text not null,location text not null,source_root text not null,created_at text not null)")

    @staticmethod
    def valid_id(project_id: str) -> None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", project_id or ""):
            raise ValueError("project_id: 1–64 lowercase Latin letters, digits, hyphens or underscores")
        if project_id.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *("COM" + str(n) for n in range(1, 10)), *("LPT" + str(n) for n in range(1, 10))}:
            raise ValueError("Reserved project_id")

    def project(self, project_id: str) -> dict:
        self.valid_id(project_id)
        with connection(self.registry, readonly=True) as db:
            row = db.execute("select * from projects where project_id=?", (project_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown project_id: " + project_id)
        return dict(row)

    def db_path(self, project_id: str) -> Path:
        self.project(project_id)
        return self.home / "projects" / project_id / "project.sqlite3"

    def create_project(self, project_id: str, name: str, source_root: str | Path, location: str = "") -> dict:
        self.valid_id(project_id)
        root = Path(source_root).expanduser().resolve(strict=True)
        if not root.is_dir() or not name.strip():
            raise ValueError("A source directory and nonempty project name are required")
        if self.home == root or self.home.is_relative_to(root):
            raise ValueError("State directory must be outside the source directory")
        folder = self.home / "projects" / project_id
        # The exclusive directory creation also rejects a repeated project registration.
        folder.mkdir(parents=True, exist_ok=False)
        with connection(folder / "project.sqlite3") as db:
            db.executescript(PROJECT_SQL)
            db.executemany("insert into metadata values (?,?)", [("schema", SCHEMA), ("source_root", str(root)), ("snapshot_created", now()), ("approval_status", "unconfirmed")])
        with connection(self.registry) as db:
            db.execute("insert into projects values (?,?,?,?,?)", (project_id, name.strip(), location, str(root), now()))
        return self.project(project_id)

    def list_projects(self) -> dict:
        with connection(self.registry, readonly=True) as db:
            rows = [dict(r) for r in db.execute("select * from projects order by created_at,project_id")]
        result = []
        for row in rows:
            item = {k: row[k] for k in ("project_id", "name", "location")}
            item["id"] = item["project_id"]
            try:
                status = self.project_status(row["project_id"])
                item.update(status="ready", counts=status["counts"], questions=status["questions"], snapshot_created=status["snapshot"]["snapshot_created"])
            except (OSError, sqlite3.Error, ValueError) as exc:
                item.update(status="unavailable", error=str(exc))
            result.append(item)
        return {"projects": result, "default_project": rows[0]["project_id"] if rows else None}

    def project_status(self, project_id: str) -> dict:
        project = self.project(project_id)
        with connection(self.db_path(project_id), readonly=True) as db:
            meta = dict(db.execute("select key,value from metadata"))
            counts = {t: db.execute("select count(*) from " + t).fetchone()[0] for t in ("documents", "chunks", "checks")}
            counts["pages"] = db.execute("select count(*) from pages p join documents d on d.doc_id=p.doc_id and d.sha256=p.sha256 and d.parser_revision=p.parser_revision where d.index_status='text_indexed'").fetchone()[0]
            counts["facts"] = db.execute("select count(*) from facts where active=1").fetchone()[0]
            coverage = {r[0]: r[1] for r in db.execute("select index_status,count(*) from documents group by index_status")}
            drawing_counts = {}
            if db.execute("select 1 from sqlite_master where name='drawing_records'").fetchone():
                drawing_counts = {r[0]: r[1] for r in db.execute(
                    "select kind,count(distinct id) from drawing_records group by kind")}
        questions = sum(c["status"] != "matches" for c in self.get_reconciliation(project_id)["checks"])
        return {"project": project, "snapshot": meta, "counts": counts, "coverage": coverage, "questions": questions,
                "drawing_work": {"counts": drawing_counts, "resume_tool": "get_drawing_measurements",
                                 "note": "Recorded work only; read records for source freshness, unresolved questions and revisions."},
                "limitations": ["Text indexing is not a complete numerical or engineering audit.", "Observations are unconfirmed; source metadata matches do not approve a revision.", "RVT/IFC extraction and scheduling have separate coverage; OCR and automatic approved POS/PPR generation are not implemented."]}

    def source_record(self, project_id: str, doc_id: str) -> tuple[dict, Path]:
        with connection(self.db_path(project_id), readonly=True) as db:
            row = db.execute("select * from documents where doc_id=?", (doc_id,)).fetchone()
            uploaded = None
            if db.execute("select 1 from sqlite_master where name='uploaded_sources'").fetchone():
                uploaded = db.execute('select relative_path from uploaded_sources where doc_id=?',(doc_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown document in selected project")
        record = dict(row)
        root = Path(self.project(project_id)["source_root"]).resolve()
        relative = record['relative_path']
        if uploaded:
            parent=self.db_path(project_id).parent.resolve();root=(parent/'uploads').resolve()
            if not root.is_relative_to(parent):raise ValueError('Upload directory is outside the project state')
            relative=uploaded['relative_path']
        target = (root / relative).resolve()
        if target == root or not target.is_relative_to(root):
            raise ValueError("Source is outside the project's source root")
        return record, target

    def source_state(self, project_id: str, doc_id: str, *, full_hash: bool = False) -> dict:
        record, target = self.source_record(project_id, doc_id)
        if not target.is_file():
            return {"status": "source_unavailable"}
        stat = target.stat()
        if (stat.st_size, stat.st_mtime_ns) != (record["size_bytes"], record["mtime_ns"]):
            return {"status": "needs_refresh"}
        if full_hash and digest(target) != record["sha256"]:
            return {"status": "needs_refresh"}
        return {"status": "content_hash_matches" if full_hash else "snapshot_metadata_matches", "note": "Source freshness is separate from revision acceptance."}

    def find_documents(self, project_id: str, query: str = "", limit: int = 20, offset: int = 0) -> dict:
        limit = max(1, min(int(limit), 50)); offset = max(0, int(offset))
        with connection(self.db_path(project_id), readonly=True) as db:
            total = db.execute("select count(*) from documents where casefold(relative_path) like casefold(?)", ("%" + query + "%",)).fetchone()[0]
            rows = [dict(r) for r in db.execute("select * from documents where casefold(relative_path) like casefold(?) order by relative_path limit ? offset ?", ("%" + query + "%", limit, offset))]
        return {"project_id": project_id, "documents": rows, "total": total, "offset": offset, "limit": limit, "next_offset": offset + len(rows) if offset + len(rows) < total else None}

    def search_project(self, project_id: str, query: str, limit: int = 6, doc_id: str | None = None) -> dict:
        terms = re.findall(r"\w+", query, re.UNICODE)[:12]
        if not terms:
            return {"project_id": project_id, "results": []}
        expression = " AND ".join('"' + term + '"*' for term in terms)
        sql = """select ch.doc_id,ch.sha256,ch.page_number,d.relative_path,d.parser_revision,
          snippet(chunk_fts,0,'[',']',' … ',40) snippet,bm25(chunk_fts) rank
          from chunk_fts join chunks ch on ch.chunk_id=chunk_fts.rowid
          join documents d on d.doc_id=ch.doc_id
          where chunk_fts match ? and d.index_status='text_indexed'"""
        args: list = [expression]
        if doc_id:
            sql += " and ch.doc_id=?"; args.append(doc_id)
        sql += " order by rank limit ?"; args.append(max(1, min(int(limit), 15)))
        with connection(self.db_path(project_id), readonly=True) as db:
            rows = [dict(r) for r in db.execute(sql, args)]
        for row in rows:
            row["freshness"] = self.source_state(project_id, row["doc_id"])["status"]
        return {"project_id": project_id, "results": rows, "retrieval": "SQLite FTS5 prefixes; no model or embeddings", "warning": "Open the source locator before accepting a number; a query is not a full source review."}

    def read_evidence(self, project_id: str, doc_id: str, page_number: int = 1, offset: int = 0, max_chars: int = 5000, sha256: str | None = None, parser_revision: str | None = None) -> dict:
        if page_number < 1 or offset < 0:
            raise ValueError("page_number >= 1 and offset >= 0 required")
        record, _ = self.source_record(project_id, doc_id)
        sha = sha256 or record["sha256"]
        parser = parser_revision or record["parser_revision"]
        with connection(self.db_path(project_id), readonly=True) as db:
            row = db.execute("select * from pages where doc_id=? and sha256=? and parser_revision=? and page_number=?", (doc_id, sha, parser, page_number)).fetchone()
        if row is None:
            raise ValueError("Page/block not indexed for this document version")
        end = offset + max(200, min(int(max_chars), 12000)); text = row["text"]
        freshness = self.source_state(project_id, doc_id)
        if sha != record["sha256"] or parser != record["parser_revision"]:
            freshness = {"status": "historical_snapshot", "note": "Original file may represent another version; cached text is retained."}
        return {"project_id": project_id, "doc_id": doc_id, "sha256": sha, "parser_revision": parser, "source_path": record["relative_path"], "page_number": page_number,
                "locator": json.loads(row["locator"]), "text": text[offset:end], "next_offset": end if end < len(text) else None, "low_text": bool(row["low_text"]), "freshness": freshness}

    def get_project_facts(self, project_id: str, group: str | None = None) -> dict:
        sql = "select payload from facts where active=1"; args = []
        if group:
            sql += " and fact_group=?"; args.append(group)
        with connection(self.db_path(project_id), readonly=True) as db:
            facts = [json.loads(r[0]) for r in db.execute(sql, args)]
        for fact in facts:
            states = {}
            for source in fact["sources"]:
                current, _ = self.source_record(project_id, source["doc_id"])
                states[source["doc_id"]] = "stale_version" if current["sha256"] != source["sha256"] or current["parser_revision"] != source.get("parser_revision", current["parser_revision"]) else self.source_state(project_id, source["doc_id"])["status"]
            fact["source_freshness"] = states
        return {"project_id": project_id, "facts": facts, "coverage": "Recorded observations only; not all numbers have been extracted or accepted."}

    def get_reconciliation(self, project_id: str, status: str | None = None) -> dict:
        sql = "select payload from checks"; args = []
        with connection(self.db_path(project_id), readonly=True) as db:
            checks = [json.loads(r[0]) for r in db.execute(sql, args)]
        facts = {f["id"]: f for f in self.get_project_facts(project_id)["facts"]}
        for check in checks:
            if any(facts.get(k, {}).get("revision") != rev or any(v not in ("snapshot_metadata_matches", "content_hash_matches") for v in facts.get(k, {}).get("source_freshness", {}).values()) for k, rev in check.get("fact_revisions", {}).items()):
                check.update(status="needs_review", stale_reason="An input observation or source changed")
        if status:
            checks = [r for r in checks if r["status"] == status]
        return {"project_id": project_id, "checks": checks, "scope": "Checks of recorded comparable observations; not a complete engineering audit."}

    def get_evidence_chain(self, project_id: str, fact_id: str) -> dict:
        facts = self.get_project_facts(project_id)["facts"]
        fact = next((f for f in facts if f["id"] == fact_id), None)
        if not fact:
            raise ValueError("Unknown observation in selected project")
        with connection(self.db_path(project_id), readonly=True) as db:
            history = [json.loads(r[0]) for r in db.execute("select payload from facts where fact_id=? order by revision", (fact_id,))]
        return {"project_id": project_id, "fact": fact, "history": history, "checks": [c for c in self.get_reconciliation(project_id)["checks"] if fact_id in c["fact_ids"]]}

    def record_observations(self, project_id: str, observations: list[dict], request_id: str) -> dict:
        """Append source-backed, unapproved observations; retry is idempotent."""
        if not request_id or len(request_id) > 128 or not 1 <= len(observations) <= 40:
            raise ValueError("request_id and a batch of 1–40 observations are required")
        if len(encode(observations)) > 100000:
            raise ValueError("Observation batch exceeds 100000 characters")
        fingerprint = hashlib.sha256(encode(observations).encode()).hexdigest()
        with connection(self.db_path(project_id)) as db:
            db.execute("begin immediate")
            previous = db.execute("select * from requests where request_id=?", (request_id,)).fetchone()
            if previous:
                if previous["payload_hash"] != fingerprint:
                    raise ValueError("request_id was already used with different data")
                return json.loads(previous["result"])
            saved = []; seen = set()
            for item in observations:
                for key in ("name", "group", "unit", "basis", "raw_value", "sources"):
                    if not item.get(key):
                        raise ValueError("Observation requires " + key)
                if "value" not in item:
                    raise ValueError("Observation requires value (null means unknown)")
                if item.get("revision_approved") or item.get("status") not in (None, "source_observation"):
                    raise ValueError("This tool cannot approve an engineering value")
                fact_id = str(item.get("id") or uuid4())
                if not re.fullmatch(r"[\w.-]{1,80}", fact_id) or fact_id in seen:
                    raise ValueError("Invalid or duplicate observation ID")
                seen.add(fact_id)
                old = db.execute("select * from facts where fact_id=? and active=1", (fact_id,)).fetchone()
                if old and (not item.get("correction_reason") or item.get("expected_revision") != old["revision"]):
                    raise ValueError("Correction requires reason and current expected_revision")
                sources = json.loads(encode(item["sources"]))
                if not isinstance(sources, list) or not 1 <= len(sources) <= 8:
                    raise ValueError("1–8 exact source locators required")
                for source in sources:
                    record, _ = self.source_record(project_id, source["doc_id"])
                    if source.get("sha256") != record["sha256"] or self.source_state(project_id, source["doc_id"], full_hash=True)["status"] != "content_hash_matches":
                        raise ValueError("Source changed; refresh and reread before recording")
                    if source.get("parser_revision", record["parser_revision"]) != record["parser_revision"]:
                        raise ValueError("Extraction changed; reread the source block")
                    source["parser_revision"] = record["parser_revision"]
                    evidence = self.read_evidence(project_id, source["doc_id"], int(source["page_number"]), max_chars=12000)
                    # Exact literal evidence is required, but its semantic interpretation remains unapproved.
                    with connection(self.db_path(project_id), readonly=True) as read:
                        text = read.execute("select text from pages where doc_id=? and sha256=? and parser_revision=? and page_number=?", (source["doc_id"], source["sha256"], source["parser_revision"], int(source["page_number"]))).fetchone()[0]
                    literal = normalized(item["raw_value"])
                    haystack = normalized(text)
                    found = bool(re.search(r"(?<![\d.,])" + re.escape(literal) + r"(?![\d.,])", haystack)) if re.fullmatch(r"[-+]?\d+(?:[.,]\d+)?", literal) else literal in haystack
                    if not found:
                        raise ValueError("raw_value must occur in every cited page/block")
                    if source.get("sheet") and source["sheet"] != evidence["locator"].get("sheet"):
                        raise ValueError("Source sheet does not match the block")
                revision = old["revision"] + 1 if old else 1
                fact = {k: v for k, v in item.items() if k not in {"expected_revision", "revision_approved", "status"}}
                fact.update(id=fact_id, project_id=project_id, revision=revision, status="source_observation", revision_approved=False, recorded_at=now(), sources=sources)
                if old:
                    db.execute("update facts set active=0 where fact_id=?", (fact_id,))
                    for row in db.execute("select * from checks").fetchall():
                        check = json.loads(row["payload"])
                        if fact_id in check["fact_ids"]:
                            check.update(status="needs_review", stale_reason="Observation corrected")
                            db.execute("update checks set status=?,payload=? where check_id=?", ("needs_review", encode(check), row["check_id"]))
                db.execute("insert into facts values (?,?,?,?,1)", (fact_id, revision, fact["group"], encode(fact)))
                db.execute("insert into events(created_at,kind,payload) values (?,?,?)", (now(), "observation_corrected" if old else "observation_recorded", encode(fact)))
                saved.append({"id": fact_id, "revision": revision})
            result = {"project_id": project_id, "observations": saved, "status": "source_observation", "note": "Recording evidence does not accept the engineering interpretation."}
            db.execute("insert into requests values (?,?,?)", (request_id, fingerprint, encode(result)))
        return result

    def compare_facts(self, project_id: str, first_id: str, second_id: str, tolerance: str = "0") -> dict:
        if first_id == second_id:
            raise ValueError("Choose two distinct observations")
        facts = {f["id"]: f for f in self.get_project_facts(project_id)["facts"]}
        if first_id not in facts or second_id not in facts:
            raise ValueError("Both observation IDs must belong to the selected project")
        a, b = facts[first_id], facts[second_id]
        result = compare_quantity(a, b, tolerance)
        if any(v not in ("snapshot_metadata_matches", "content_hash_matches") for f in (a, b) for v in f["source_freshness"].values()):
            result = {"status": "needs_review", "explanation": "A source is stale or unavailable"}
        check = {"id": str(uuid4()), "project_id": project_id, "title": a["name"] + " ↔ " + b["name"], "fact_ids": [first_id, second_id], "fact_revisions": {f["id"]: f["revision"] for f in (a, b)},
                 "sources": a["sources"] + b["sources"], "created_at": now(), **result}
        with connection(self.db_path(project_id)) as db:
            db.execute("insert into checks values (?,?,?)", (check["id"], check["status"], encode(check)))
        return check


UNITS = {"m": ("length", "1"), "mm": ("length", ".001"), "cm": ("length", ".01"), "km": ("length", "1000"),
         "m2": ("area", "1"), "ha": ("area", "10000"), "10 m2": ("area", "10"), "1000 m2": ("area", "1000"),
         "m3": ("volume", "1"), "100 m3": ("volume", "100"), "kg": ("mass", "1"), "t": ("mass", "1000"),
         "piece": ("count", "1"), "kW": ("power", "1"), "W": ("power", ".001"), "m3/day": ("daily_water", "1"), "l/s": ("flow", "1")}


def compare_quantity(a: dict, b: dict, tolerance: str = "0") -> dict:
    for key in ("entity", "property", "basis", "revision_set"):
        if not a.get(key) or not b.get(key):
            return {"status": "not_comparable", "explanation": "Missing semantic field: " + key}
        if a[key] != b[key]:
            return {"status": "question", "explanation": "Different " + key}
    if a.get("specification") != b.get("specification"):
        return {"status": "question", "explanation": "Different material/size/specification"}
    if a.get("value") is None or b.get("value") is None:
        return {"status": "not_comparable", "explanation": "Missing value is not zero"}
    ua, ub = UNITS.get(a.get("unit")), UNITS.get(b.get("unit"))
    if not ua or not ub or ua[0] != ub[0]:
        return {"status": "not_comparable", "explanation": "Units need an explicit compatible conversion"}
    try:
        av, bv = Decimal(str(a["value"])), Decimal(str(b["value"]))
        tol = Decimal(tolerance)
        if not all(v.is_finite() for v in (av, bv, tol)) or tol < 0:
            raise ValueError("Finite values and nonnegative tolerance required")
        if any(len(v.as_tuple().digits) > 128 or abs(v.as_tuple().exponent) > 1000 for v in (av, bv, tol)):
            raise ValueError("Decimal exceeds supported precision/exponent bounds")
        with localcontext() as ctx:
            ctx.prec = max(50, max(v.adjusted() for v in (av, bv, tol)) - min(v.as_tuple().exponent for v in (av, bv, tol)) + 16)
            delta = bv * Decimal(ub[1]) - av * Decimal(ua[1])
    except (InvalidOperation, TypeError) as exc:
        raise ValueError("Values and tolerance must be decimal strings") from exc
    return {"status": "matches" if abs(delta) <= tol else "question", "difference": str(delta), "base_dimension": ua[0], "tolerance": str(tol),
            "explanation": "Compared with explicit units and semantic scope. This is not engineering acceptance."}
