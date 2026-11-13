"""Resumable model parsing of a fixed set of literal extraction snapshots."""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
import re

from .core import connection, encode, now
from .design_navigation import path_hints, text_hints


SCHEMA = """
create table if not exists parse_jobs(
 job_id text primary key, purpose text not null, doc_ids text not null, created_at text not null);
create table if not exists parse_documents(
 job_id text not null references parse_jobs(job_id), doc_id text not null,
 snapshot text not null, primary key(job_id, doc_id));
create table if not exists parse_units(
 job_id text not null, unit_number integer not null, doc_id text not null, page_number integer,
 state text not null, note text not null, observations text not null,
 primary key(job_id, unit_number),
 foreign key(job_id, doc_id) references parse_documents(job_id, doc_id));
create index if not exists parse_unit_state on parse_units(job_id, state, unit_number);
create table if not exists parse_submissions(
 job_id text not null references parse_jobs(job_id), request_id text not null, payload text not null,
 result text not null, primary key(job_id, request_id));
"""
OUTCOMES = ("observed", "no_data", "blocked")
SNAPSHOT_FIELDS = ("doc_id", "relative_path", "sha256", "parser_revision", "index_status",
                   "size_bytes", "mtime_ns", "page_count", "error")
OBSERVATION_FIELDS = ("name", "group", "value", "raw_value", "unit", "basis",
                      "entity", "property", "revision_set", "specification")


def identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", value):
        raise ValueError(label + " must be 1–64 letters, digits, underscores, dots or hyphens")


class ParseWork:
    def __init__(self, workspace, project_id):
        self.workspace = workspace
        self.project_id = project_id
        self.path = workspace.db_path(project_id)

    def start(self, job_id, doc_ids, purpose):
        identifier(job_id, "job_id")
        if (not isinstance(doc_ids, list) or not 1 <= len(doc_ids) <= 20
                or any(not isinstance(doc_id, str) for doc_id in doc_ids)
                or len(set(doc_ids)) != len(doc_ids)):
            raise ValueError("Choose 1–20 distinct registered doc_ids")
        if not isinstance(purpose, str) or not 1 <= len(purpose.strip()) <= 2000:
            raise ValueError("Describe what to extract in purpose (1–2000 characters)")
        purpose = purpose.strip()
        with connection(self.path) as db:
            db.executescript(SCHEMA)
            db.execute("begin immediate")
            existing = db.execute("select * from parse_jobs where job_id=?", (job_id,)).fetchone()
            if existing:
                if existing["doc_ids"] != encode(doc_ids) or existing["purpose"] != purpose:
                    raise ValueError("job_id already identifies a different parsing scope")
            else:
                db.execute("insert into parse_jobs values (?,?,?,?)", (job_id, purpose, encode(doc_ids), now()))
                unit_number = 0
                for doc_id in doc_ids:
                    row = db.execute("select * from documents where doc_id=?", (doc_id,)).fetchone()
                    if row is None:
                        raise ValueError("Unknown document in selected project: " + doc_id)
                    snapshot = {key: row[key] for key in SNAPSHOT_FIELDS}
                    db.execute("insert into parse_documents values (?,?,?)", (job_id, doc_id, encode(snapshot)))
                    pages = []
                    if row["index_status"] == "text_indexed":
                        pages = [p[0] for p in db.execute(
                            """select page_number from pages where doc_id=? and sha256=? and parser_revision=?
                            order by page_number limit ?""",
                            (doc_id, row["sha256"], row["parser_revision"], 100001 - unit_number))]
                    if unit_number + max(1, len(pages)) > 100000:
                        raise ValueError("Parsing scope exceeds 100000 units; choose fewer documents")
                    state = "pending" if pages else "blocked"
                    note = "" if pages else row["error"] or "No literal blocks available. Inspect or refresh this source."
                    db.executemany("insert into parse_units values (?,?,?,?,?,?, '[]')",
                                   ((job_id, unit_number + n, doc_id, page, state, note)
                                    for n, page in enumerate(pages or [None], 1)))
                    unit_number += len(pages) or 1
        return self.get(job_id)

    def _freshness(self, db, snapshot, full_hash):
        doc_id = snapshot["doc_id"]
        row = db.execute("select * from documents where doc_id=?", (doc_id,)).fetchone()
        version_fields = ("sha256", "parser_revision", "index_status", "page_count")
        if not snapshot["sha256"]:
            version_fields += ("size_bytes", "mtime_ns")
        if row is None or any(row[key] != snapshot[key] for key in version_fields):
            return "snapshot_changed"
        try:
            return self.workspace.source_state(
                self.project_id, doc_id, full_hash=full_hash and bool(snapshot["sha256"]), _db=db
            )["status"]
        except (ValueError, OSError):
            return "source_unavailable"

    def get(self, job_id=None, state="pending", offset=0, limit=20, verify_sources=False):
        if state not in ("all", "pending", "stale", *OUTCOMES) or offset < 0 or not 1 <= limit <= 50:
            raise ValueError("Choose a valid state, nonnegative offset and limit 1–50")
        with connection(self.path, readonly=True) as db:
            db.execute("begin")
            initialized = db.execute("select 1 from sqlite_master where name='parse_jobs'").fetchone()
            if job_id is None:
                jobs = db.execute("select * from parse_jobs order by created_at desc, job_id limit ? offset ?",
                                  (limit + 1, offset)).fetchall() if initialized else []
                return {"project_id": self.project_id, "jobs": [
                    {**dict(job), "doc_ids": json.loads(job["doc_ids"])} for job in jobs[:limit]],
                    "next_offset": offset + limit if len(jobs) > limit else None}
            job = db.execute("select * from parse_jobs where job_id=?", (job_id,)).fetchone() if initialized else None
            if job is None:
                raise ValueError("Unknown parsing job in selected project")
            documents = {row["doc_id"]: json.loads(row["snapshot"]) for row in db.execute(
                "select * from parse_documents where job_id=?", (job_id,))}
            stale = []
            for doc_id, document in documents.items():
                document["freshness"] = self._freshness(db, document, verify_sources)
                document["navigation_hints"] = path_hints(document["relative_path"])
                if document["freshness"] not in {"snapshot_metadata_matches", "content_hash_matches"}:
                    stale.append(doc_id)
            counts = Counter({key: 0 for key in ("pending", *OUTCOMES, "stale")})
            for row in db.execute(
                "select doc_id,state,count(*) n from parse_units where job_id=? group by doc_id,state", (job_id,)
            ):
                counts["stale" if row["doc_id"] in stale else row["state"]] += row["n"]
            predicate, args = "", [job_id]
            if state not in {"all", "stale"}:
                predicate = " and u.state=?"
                args.append(state)
            if stale and state != "all":
                placeholders = ",".join("?" for _ in stale)
                predicate += f" and u.doc_id {'in' if state == 'stale' else 'not in'} ({placeholders})"
                args.extend(stale)
            elif state == "stale":
                predicate = " and 0"
            rows = db.execute(
                """select u.*,p.locator,p.low_text,substr(p.text,1,4000) excerpt
                from parse_units u join parse_documents d using(job_id,doc_id)
                left join pages p on p.doc_id=u.doc_id and p.page_number=u.page_number
                 and p.sha256=json_extract(d.snapshot,'$.sha256')
                 and p.parser_revision=json_extract(d.snapshot,'$.parser_revision')
                where u.job_id=?""" + predicate + " order by u.unit_number limit ? offset ?",
                (*args, limit + 1, offset)).fetchall()
        units = []
        for row in rows[:limit]:
            document = documents[row["doc_id"]]
            source = {key: document[key] for key in ("doc_id", "sha256", "parser_revision")}
            source["page_number"] = row["page_number"]
            locator = json.loads(row["locator"]) if row["locator"] else {}
            units.append({"unit_number": row["unit_number"], "source": source,
                          "locator": {key: value for key, value in locator.items() if key != "cells"},
                          "navigation_hints": text_hints(row["excerpt"] or ""),
                          "low_text": bool(row["low_text"]), "state": row["state"],
                          "stale": row["doc_id"] in stale, "note": row["note"],
                          "observations": json.loads(row["observations"])})
        return {"project_id": self.project_id, "job_id": job_id, "purpose": job["purpose"],
                "documents": [documents[doc_id] for doc_id in json.loads(job["doc_ids"])],
                "counts": dict(counts), "total": sum(counts.values()), "units": units,
                "next_offset": offset + limit if len(rows) > limit else None,
                "complete": not any(counts[key] for key in ("pending", "stale", "blocked")),
                "coverage_basis": "Selected literal blocks plus documents without blocks", "accepted": False}

    def submit(self, job_id, request_id, results):
        identifier(job_id, "job_id")
        identifier(request_id, "request_id")
        if not isinstance(results, list) or not 1 <= len(results) <= 20 or len(encode(results)) > 100000:
            raise ValueError("Submit 1–20 unit results, at most 100000 characters")
        payload = encode(results)
        with connection(self.path) as db:
            db.execute("begin immediate")
            if (not db.execute("select 1 from sqlite_master where name='parse_jobs'").fetchone()
                    or not db.execute("select 1 from parse_jobs where job_id=?", (job_id,)).fetchone()):
                raise ValueError("Unknown parsing job in selected project")
            previous = db.execute("select * from parse_submissions where job_id=? and request_id=?",
                                  (job_id, request_id)).fetchone()
            if previous:
                if previous["payload"] != payload:
                    raise ValueError("request_id was already used with different results")
                return json.loads(previous["result"])
            observed, updates = self._prepare(db, job_id, results)
            saved = []
            if observed:
                # Namespaced ID fits the observation request limit and also rolls back with the queue.
                key = "parse-" + sha256(encode([job_id, request_id]).encode()).hexdigest()
                saved = self.workspace._record_observations(
                    self.project_id, observed, key, transaction=db)["observations"]
            receipt = []
            for number, state, note, start, end in updates:
                observations = saved[start:end]
                db.execute("update parse_units set state=?,note=?,observations=? where job_id=? and unit_number=?",
                           (state, note, encode(observations), job_id, number))
                receipt.append({"unit_number": number, "state": state, "observations": observations})
            result = {"project_id": self.project_id, "job_id": job_id, "results": receipt, "accepted": False}
            db.execute("insert into parse_submissions values (?,?,?,?)", (job_id, request_id, payload, encode(result)))
        return result

    def _prepare(self, db, job_id, results):
        observations, updates, verified, seen = [], [], set(), set()
        for result in results:
            if not isinstance(result, dict):
                raise ValueError("Each result must be an object")
            number, state, note, items = (result.get("unit_number"), result.get("state"),
                                          result.get("note", ""), result.get("observations", []))
            if type(number) is not int or number in seen or state not in OUTCOMES:
                raise ValueError("Each result needs a distinct unit_number and a valid state")
            seen.add(number)
            if not isinstance(note, str) or len(note) > 2000 or (state != "observed" and not note.strip()):
                raise ValueError("Blocked and no_data require a note (at most 2000 characters)")
            if not isinstance(items, list) or bool(items) != (state == "observed"):
                raise ValueError("Only observed results contain observations and require at least one")
            row = db.execute(
                """select u.*,d.snapshot,p.low_text from parse_units u join parse_documents d using(job_id,doc_id)
                left join pages p on p.doc_id=u.doc_id and p.page_number=u.page_number
                 and p.sha256=json_extract(d.snapshot,'$.sha256')
                 and p.parser_revision=json_extract(d.snapshot,'$.parser_revision')
                where u.job_id=? and u.unit_number=?""", (job_id, number)).fetchone()
            if row is None or row["state"] not in {"pending", "blocked"}:
                raise ValueError("Unit is unknown or already resolved; reload the parsing job")
            document = json.loads(row["snapshot"])
            doc_id = row["doc_id"]
            if (state == "no_data" and row["low_text"] and document["relative_path"].lower().endswith(".pdf")
                    and result.get("method") != "visual_original"):
                raise ValueError("For a sparse PDF page, confirm visual_original or leave the unit blocked")
            if state != "blocked":
                if row["page_number"] is None:
                    raise ValueError("Unit has no literal block; refresh or use an appropriate reader")
                if doc_id not in verified:
                    if self._freshness(db, document, True) != "content_hash_matches":
                        raise ValueError("Source changed; refresh extraction and start a new parsing job")
                    verified.add(doc_id)
            source = {key: document[key] for key in ("doc_id", "sha256", "parser_revision")}
            source["page_number"] = row["page_number"]
            start = len(observations)
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("raw_value"), str) or not item["raw_value"].strip():
                    raise ValueError("Observation requires a nonempty literal raw_value")
                fields = {key: item[key] for key in OBSERVATION_FIELDS if key in item}
                observations.append({**fields, "sources": [source], "reader": "model",
                                     "parse_job_id": job_id, "parse_unit_number": number})
            updates.append((number, state, note, start, len(observations)))
        return observations, updates
