"""Incremental local intake with content cache and explicit format coverage."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4, uuid5, NAMESPACE_URL

from .core import Workspace, connection, digest, encode, now
from .readers import READER_REVISION, SUPPORTED, read_blocks, revision_for

IGNORE = {".git", ".venv", "venv", "envs", "node_modules", "__pycache__", "cache", "backups", "artifacts"}


def scan(workspace: Workspace, project_id: str, limit: int = 100) -> dict:
    if not 1 <= limit <= 10000:
        raise ValueError("limit must be 1–10000")
    root = Path(workspace.project(project_id)["source_root"])
    if not root.is_dir():
        raise ValueError("Source root unavailable; previous inventory preserved")
    candidates = []
    def fail(exc):
        raise exc
    for directory, dirs, leaves in os.walk(root, followlinks=False, onerror=fail):
        dirs[:] = [name for name in dirs if name not in IGNORE and not name.startswith(".") and not Path(directory, name).is_symlink() and not getattr(Path(directory, name), "is_junction", lambda: False)()]
        for name in sorted(leaves):
            path = Path(directory, name)
            if name.startswith((".", "~$")) or path.is_symlink() or not path.is_file():
                continue
            if not path.resolve().is_relative_to(root.resolve()):
                continue
            candidates.append(path)
    pending = []
    with connection(workspace.db_path(project_id)) as db:
        db.execute("begin immediate")
        seen = set()
        for path in sorted(candidates):
            relative = path.relative_to(root).as_posix()
            doc_id = uuid5(NAMESPACE_URL, project_id + "/" + relative).hex
            seen.add(doc_id); stat = path.stat()
            row = db.execute("select * from documents where doc_id=?", (doc_id,)).fetchone()
            # Hash every supported source, even when timestamp/size are unchanged.
            supported = path.suffix.lower() in SUPPORTED
            revision = revision_for(path.suffix.lower())
            sha = digest(path) if supported and stat.st_size <= 64 * 1024 * 1024 else None
            unchanged = row and row["sha256"] == sha and row["parser_revision"] == revision and row["index_status"] == "text_indexed"
            if unchanged:
                db.execute("update documents set size_bytes=?,mtime_ns=? where doc_id=?", (stat.st_size, stat.st_mtime_ns, doc_id))
                continue
            status = "pending" if supported else "unsupported"
            if row:
                # Invalidate search immediately; immutable pages/observations remain traceable.
                ids = [r[0] for r in db.execute("select chunk_id from chunks where doc_id=?", (doc_id,))]
                db.executemany("delete from chunk_fts where rowid=?", [(i,) for i in ids])
                db.execute("delete from chunks where doc_id=?", (doc_id,))
            db.execute("insert or replace into documents(doc_id,relative_path,extension,sha256,size_bytes,mtime_ns,page_count,index_status,parser_revision,error) values (?,?,?,?,?,?,0,?,?,null)",
                       (doc_id, relative, path.suffix.lower(), sha, stat.st_size, stat.st_mtime_ns, status, revision))
            if supported:
                pending.append((doc_id, path, sha, revision))
        for row in db.execute("select doc_id,index_status from documents").fetchall():
            if row["doc_id"] not in seen:
                ids = [r[0] for r in db.execute("select chunk_id from chunks where doc_id=?", (row["doc_id"],))]
                db.executemany("delete from chunk_fts where rowid=?", [(i,) for i in ids])
                db.execute("delete from chunks where doc_id=?", (row["doc_id"],))
                db.execute("update documents set index_status='source_missing' where doc_id=?", (row["doc_id"],))
        db.execute("insert or replace into metadata values ('snapshot_created',?)", (now(),))
    cache = workspace.home / "cache" / READER_REVISION
    cache.mkdir(parents=True, exist_ok=True)
    processed = []; errors = []
    for doc_id, path, sha, revision in pending[:limit]:
        try:
            before = path.stat()
            if sha is None:
                raise ValueError("Source exceeds 64 MiB")
            cache_path = cache / (sha + "." + hashlib.sha256(revision.encode()).hexdigest()[:16] + path.suffix.lower() + ".json")
            reused = cache_path.is_file()
            blocks = json.loads(cache_path.read_text(encoding="utf-8")) if reused else read_blocks(path)
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or digest(path) != sha:
                raise ValueError("Source changed during reading; previous evidence is retained")
            with connection(workspace.db_path(project_id)) as db:
                db.execute("begin immediate")
                current = db.execute("select sha256,index_status,parser_revision from documents where doc_id=?", (doc_id,)).fetchone()
                if not current or current["sha256"] != sha or current["index_status"] != "pending" or current["parser_revision"] != revision:
                    raise ValueError("Source registration changed while reading")
                db.execute("insert or ignore into document_versions values (?,?,?,?)", (doc_id, sha, revision, now()))
                for n, block in enumerate(blocks, 1):
                    text = block["text"]
                    db.execute("insert or replace into pages values (?,?,?,?,?,?,?)", (doc_id, sha, revision, n, text, encode(block["locator"]), int(len(text.strip()) < 80)))
                    for part, start in enumerate(range(0, len(text), 1600)):
                        chunk = text[start:start + 1800]
                        cur = db.execute("insert into chunks(doc_id,sha256,page_number,part,text) values (?,?,?,?,?)", (doc_id, sha, n, part, chunk))
                        db.execute("insert into chunk_fts(rowid,text) values (?,?)", (cur.lastrowid, chunk))
                db.execute("update documents set index_status=?,page_count=?,size_bytes=?,mtime_ns=?,error=null where doc_id=?", ("text_indexed" if blocks else "empty_text", len(blocks), after.st_size, after.st_mtime_ns, doc_id))
                db.execute("insert into events(created_at,kind,payload) values (?,?,?)", (now(), "source_indexed", encode({"doc_id": doc_id, "sha256": sha, "blocks": len(blocks), "cache_reused": reused})))
            if not reused:
                temporary = cache / (uuid4().hex + ".tmp")
                temporary.write_text(encode(blocks), encoding="utf-8")
                os.replace(temporary, cache_path)
            processed.append({"doc_id": doc_id, "blocks": len(blocks), "cache_reused": reused})
        except Exception as exc:
            with connection(workspace.db_path(project_id)) as db:
                db.execute("update documents set index_status='parse_failed',error=? where doc_id=? and sha256 is ? and parser_revision=? and index_status='pending'", (type(exc).__name__ + ": " + str(exc), doc_id, sha, revision))
            errors.append({"doc_id": doc_id, "error": str(exc)})
    return {"project_id": project_id, "processed": processed, "errors": errors, "remaining_in_batch": max(0, len(pending) - limit), "status": workspace.project_status(project_id)}
