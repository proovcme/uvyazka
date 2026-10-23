"""One local project intake service for MCP and HTTP; durable progress, no model API."""
from __future__ import annotations

import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import stat
import threading
import time
from uuid import uuid4
import zipfile

from .core import Workspace, connection, digest, encode, now

MAX_ENTRIES = 100000
LEASE_SECONDS = 90
ACTIVE = {"queued", "extracting", "indexing"}
SQL = """
create table if not exists intake_jobs(
 intake_id text primary key,project_id text,status text not null,
 owner text,lease_until real not null default 0,payload text not null);
create table if not exists intake_files(
 intake_id text not null,path text not null,size integer not null,sha256 text,
 primary key(intake_id,path));
create table if not exists intake_events(
 event_id integer primary key,intake_id text not null,created_at text not null,
 status text not null,detail text not null);
create index if not exists intake_project on intake_jobs(project_id,status);
create index if not exists intake_journal on intake_events(intake_id,event_id);
"""


def relative_path(value):
    """Portable names: reject traversal, NTFS streams, aliases and special devices."""
    if not isinstance(value, str) or not value or len(value) > 1500:
        raise ValueError("Invalid relative filename")
    if "\\" in value or re.search(r'[<>:"|?*\x00-\x1f\x7f]', value):
        raise ValueError("Unsafe filename: " + value)
    parts = value.split("/")
    devices = {"CON", "PRN", "AUX", "NUL", *("COM"+str(i) for i in range(1,10)), *("LPT"+str(i) for i in range(1,10))}
    if any(p in {"", ".", ".."} or p.endswith((".", " ")) or p.split(".")[0].upper() in devices for p in parts):
        raise ValueError("Unsafe relative path: " + value)
    return "/".join(parts)


def validate_paths(entries):
    known = {}
    for path, size in entries:
        path = relative_path(path)
        if type(size) is not int or size < 0:
            raise ValueError("Nonnegative integer file size required")
        key = path.casefold()
        if key in known:
            raise ValueError("Duplicate filename: " + path)
        known[key] = (path, size)
    if not 1 <= len(known) <= MAX_ENTRIES:
        raise ValueError("Choose 1–100000 files")
    for key in known:
        if any("/".join(key.split("/")[:n]) in known for n in range(1, len(key.split("/")))):
            raise ValueError("A filename is also used as a directory")
    return list(known.values())


class ProjectIntake:
    def __init__(self, workspace: Workspace):
        self.workspace = workspace
        with connection(workspace.registry) as db:
            db.executescript(SQL)

    def _folder(self, intake_id):
        if not re.fullmatch(r"[0-9a-f]{32}", intake_id or ""):
            raise ValueError("Invalid intake_id")
        parent = (self.workspace.home / "intakes").resolve()
        if not parent.is_relative_to(self.workspace.home):
            raise ValueError("Intake storage must remain inside local state")
        folder = parent / intake_id
        if folder.resolve() != folder:
            raise ValueError("Intake directory must not be a link")
        return folder

    def _row(self, db, intake_id):
        row = db.execute("select * from intake_jobs where intake_id=?", (intake_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown intake_id")
        return row

    def _event(self, db, intake_id, status, detail):
        db.execute("insert into intake_events(intake_id,created_at,status,detail) values (?,?,?,?)", (intake_id, now(), status, encode(detail)))

    def _insert(self, db, mode, name, project_id=None, source_root=None):
        item = {"intake_id": uuid4().hex, "project_id": project_id, "mode": mode, "name": name,
                "source_root": str(source_root) if source_root else None, "created_at": now(), "updated_at": now(),
                "phase": "receiving" if mode != "linked_folder" else "queued"}
        db.execute("insert into intake_jobs(intake_id,project_id,status,payload) values (?,?,?,?)", (item["intake_id"], project_id, item["phase"], encode(item)))
        self._event(db, item["intake_id"], item["phase"], {"mode": mode})
        return item

    def import_folder(self, source_root, name="", project_id=None, *, background=True):
        registered = self.workspace.ensure_folder_project(source_root, name, project_id)
        project = registered["project"]
        with connection(self.workspace.registry) as db:
            db.execute("begin immediate")
            active = db.execute("select intake_id from intake_jobs where project_id=? and status in ('queued','indexing') order by rowid desc limit 1", (project["project_id"],)).fetchone()
            item = {"intake_id": active[0]} if active else self._insert(db, "linked_folder", project["name"], project["project_id"], project["source_root"])
        if background:
            self.start(item["intake_id"])
        return {**self.get(item["intake_id"]), "project_reused": registered["reused"]}

    def begin_upload(self, mode, name, files=None, project_id=None):
        if mode not in {"folder_upload", "zip_upload"}:
            raise ValueError("Choose folder_upload or zip_upload")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError("Project name must contain 1–200 characters")
        if project_id is not None:
            self.workspace.valid_id(project_id)
            with connection(self.workspace.registry, readonly=True) as db:
                if db.execute("select 1 from projects where project_id=?", (project_id,)).fetchone():
                    raise ValueError("Project ID already exists; open it to continue working")
        entries = validate_paths((f["path"], f["size"]) for f in files) if mode == "folder_upload" and isinstance(files, list) else []
        if mode == "folder_upload" and not entries:
            raise ValueError("Folder manifest required")
        if sum(size for _, size in entries) > shutil.disk_usage(self.workspace.home).free:
            raise ValueError("Not enough local disk space for this folder")
        with connection(self.workspace.registry) as db:
            item = self._insert(db, mode, name.strip())
            item.update(requested_project_id=project_id, total_files=len(entries), total_bytes=sum(size for _, size in entries))
            db.execute("update intake_jobs set payload=? where intake_id=?", (encode(item), item["intake_id"]))
            db.executemany("insert into intake_files values (?,?,?,null)", [(item["intake_id"], p, n) for p,n in entries])
        (self._folder(item["intake_id"]) / "sources").mkdir(parents=True, exist_ok=False)
        return self.get(item["intake_id"])

    def _copy(self, stream, length, target):
        if type(length) is not int or length < 0 or length > shutil.disk_usage(self.workspace.home).free:
            raise ValueError("Invalid size or insufficient disk space")
        if target.is_symlink():
            raise ValueError("Target must not be a link")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.parent / (uuid4().hex + ".part")
        sha = hashlib.sha256()
        try:
            remaining = length
            with temporary.open("xb") as output:
                while remaining:
                    chunk = stream.read(min(1024*1024, remaining))
                    if not chunk:
                        raise ValueError("Upload interrupted before the declared end")
                    output.write(chunk); sha.update(chunk); remaining -= len(chunk)
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()
        return sha.hexdigest()

    def receive_file(self, intake_id, path, length, stream):
        path = relative_path(path)
        with connection(self.workspace.registry, readonly=True) as db:
            row = self._row(db, intake_id); item = json.loads(row["payload"])
            expected = db.execute("select size from intake_files where intake_id=? and path=?", (intake_id, path)).fetchone()
            if row["status"] != "receiving" or item["mode"] != "folder_upload" or not expected or expected[0] != length:
                raise ValueError("File does not match the pending folder manifest")
            root = self._folder(intake_id) / "sources"
            target = root / path
            if not target.resolve().is_relative_to(root.resolve()):
                raise ValueError("File escapes intake storage")
        with self._transfer(intake_id, "folder_upload"):
            sha = self._copy(stream, length, target)
            with connection(self.workspace.registry) as db:
                db.execute("update intake_files set sha256=? where intake_id=? and path=?", (sha, intake_id, path))
        return {"intake_id": intake_id, "path": path, "sha256": sha, "received": True}

    def receive_archive(self, intake_id, length, stream, *, background=True):
        with self._transfer(intake_id, "zip_upload"):
            sha = self._copy(stream, length, self._folder(intake_id) / "archive.zip")
            with connection(self.workspace.registry) as db:
                row = self._row(db, intake_id); item = json.loads(row["payload"])
                item.update(archive_sha256=sha, archive_bytes=length, phase="queued", updated_at=now())
                db.execute("update intake_jobs set status='queued',payload=? where intake_id=?", (encode(item), intake_id))
                self._event(db, intake_id, "queued", {"archive_bytes": length})
        if background:
            self.start(intake_id)
        return self.get(intake_id)

    def finish_folder(self, intake_id, *, background=True):
        with connection(self.workspace.registry) as db:
            db.execute("begin immediate")
            row = self._row(db, intake_id); item = json.loads(row["payload"])
            if item["mode"] != "folder_upload":
                raise ValueError("Folder upload required")
            if row["status"] == "receiving":
                if row["owner"] and row["lease_until"] > time.time():
                    raise ValueError("A file transfer is still running")
                if db.execute("select count(*) from intake_files where intake_id=? and sha256 is null", (intake_id,)).fetchone()[0]:
                    raise ValueError("Some folder files have not arrived yet; select the same folder to resume")
                item.update(phase="queued", updated_at=now())
                db.execute("update intake_jobs set status='queued',payload=? where intake_id=?", (encode(item), intake_id))
                self._event(db, intake_id, "queued", {"files": item["total_files"]})
        if background:
            self.start(intake_id)
        return self.get(intake_id)

    def get(self, intake_id=None, project_id=None, limit=10):
        if project_id:
            self.workspace.project(project_id)
        with connection(self.workspace.registry, readonly=True) as db:
            if intake_id:
                row = self._row(db, intake_id)
                if project_id and row["project_id"] != project_id:
                    raise ValueError("Intake belongs to another project")
                rows = [row]
            else:
                rows = db.execute("select * from intake_jobs" + (" where project_id=?" if project_id else "") + " order by rowid desc limit ?",
                                  (project_id, max(1,min(int(limit),40))) if project_id else (max(1,min(int(limit),40)),)).fetchall()
            items = []
            for row in rows:
                item = json.loads(row["payload"])
                received = db.execute("select count(*),coalesce(sum(size),0) from intake_files where intake_id=? and sha256 is not null", (row["intake_id"],)).fetchone()
                running = row["status"] in ACTIVE and bool(row["owner"]) and row["lease_until"] > time.time()
                item.update(status=row["status"], running=running, can_resume=row["status"] != "receiving" and not running,
                            received_files=received[0], received_bytes=received[1])
                item["journal"] = [dict(r) for r in db.execute("select created_at,status,detail from intake_events where intake_id=? order by event_id desc limit 12", (row["intake_id"],)).fetchall()][::-1]
                item["interpretation"] = "Literal extraction only. Continue semantic review using project_id and source evidence; no engineering acceptance."
                items.append(item)
        return items[0] if intake_id else {"items": items, "storage": str(self.workspace.home)}

    def _update(self, intake_id, owner, status=None, **values):
        with connection(self.workspace.registry) as db:
            db.execute("begin immediate")
            row = self._row(db, intake_id)
            if row["owner"] != owner:
                raise ValueError("Intake worker lease changed; resume from saved state")
            item = json.loads(row["payload"]); item.update(values, updated_at=now())
            if status:
                item["phase"] = status
                if status != row["status"]:
                    self._event(db, intake_id, status, values)
            db.execute("update intake_jobs set project_id=?,status=?,lease_until=?,payload=? where intake_id=?", (item.get("project_id"), status or row["status"], time.time()+LEASE_SECONDS, encode(item), intake_id))

    @contextmanager
    def _transfer(self, intake_id, mode):
        owner = uuid4().hex
        with connection(self.workspace.registry) as db:
            db.execute("begin immediate")
            row = self._row(db, intake_id)
            if row["status"] != "receiving" or json.loads(row["payload"])["mode"] != mode:
                raise ValueError("Upload is not pending")
            if row["owner"] and row["lease_until"] > time.time():
                raise ValueError("Another file transfer is running")
            db.execute("update intake_jobs set owner=?,lease_until=? where intake_id=?", (owner,time.time()+LEASE_SECONDS,intake_id))
        with self._heartbeat(intake_id, owner):
            yield owner

    @contextmanager
    def _heartbeat(self, intake_id, owner):
        stop = threading.Event()
        def heartbeat():
            while not stop.wait(15):
                try:
                    with connection(self.workspace.registry) as db:
                        db.execute("update intake_jobs set lease_until=? where intake_id=? and owner=?", (time.time()+LEASE_SECONDS,intake_id,owner))
                except Exception:
                    return
        threading.Thread(target=heartbeat, daemon=True).start()
        try:
            yield
        finally:
            stop.set()
            with connection(self.workspace.registry) as db:
                db.execute("update intake_jobs set owner=null,lease_until=0 where intake_id=? and owner=?", (intake_id,owner))

    def _extract(self, intake_id, owner):
        folder = self._folder(intake_id); root = folder / "sources"
        with zipfile.ZipFile(folder / "archive.zip") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ENTRIES:
                raise ValueError("ZIP contains more than 100000 entries")
            files = []; directories = set()
            for info in infos:
                # ZipInfo.filename may already normalize slashes/truncate NUL on Windows.
                path = relative_path(info.orig_filename.rstrip("/"))
                mode = stat.S_IFMT(info.external_attr >> 16)
                if info.flag_bits & 1 or mode not in {0, stat.S_IFREG, stat.S_IFDIR}:
                    raise ValueError("Encrypted or special ZIP entry: " + path)
                if info.is_dir():
                    directories.add(path.casefold())
                else:
                    files.append((info, path))
            entries = validate_paths((p, i.file_size) for i,p in files)
            file_keys = {p.casefold() for p,_ in entries}
            if any(d in file_keys or any("/".join(d.split("/")[:n]) in file_keys for n in range(1,len(d.split("/")))) for d in directories):
                raise ValueError("Conflicting ZIP file and directory paths")
            total = sum(size for _,size in entries)
            if total > shutil.disk_usage(folder).free:
                raise ValueError("Insufficient disk space for expanded ZIP")
            self._update(intake_id, owner, total_files=len(files), total_bytes=total, expanded_files=0)
            for n, (info, path) in enumerate(files, 1):
                target = root / path
                if not target.resolve().is_relative_to(root.resolve()):
                    raise ValueError("ZIP target escapes intake storage")
                with archive.open(info) as stream:
                    self._copy(stream, info.file_size, target)
                if n % 10 == 0 or n == len(files):
                    self._update(intake_id, owner, expanded_files=n, current_document=path)
        if digest(folder / "archive.zip") != self.get(intake_id)["archive_sha256"]:
            raise ValueError("Archive changed during extraction; project was not registered")

    def start(self, intake_id, retry_failed=False):
        if self.get(intake_id)["status"] == "receiving":
            raise ValueError("Finish uploading before processing")
        threading.Thread(target=self.run, args=(intake_id, retry_failed), daemon=True, name="uvyazka-intake").start()

    def run(self, intake_id, retry_failed=False):
        owner = uuid4().hex
        with connection(self.workspace.registry) as db:
            db.execute("begin immediate")
            row = self._row(db, intake_id)
            if row["status"] == "receiving":
                raise ValueError("Finish uploading before processing")
            if row["owner"] and row["lease_until"] > time.time() and row["status"] in ACTIVE:
                return self.get(intake_id)
            item = json.loads(row["payload"])
            item.update(phase="queued", updated_at=now())
            db.execute("update intake_jobs set owner=?,lease_until=?,status='queued',payload=? where intake_id=?", (owner, time.time()+LEASE_SECONDS, encode(item), intake_id))
            self._event(db, intake_id, "queued", {"retry_failed":retry_failed})
        with self._heartbeat(intake_id, owner):
            try:
                self._process(intake_id, owner, retry_failed)
            except Exception as exc:
                self._update(intake_id, owner, "failed", error=type(exc).__name__+": "+str(exc)[-2000:])
        return self.get(intake_id)

    def _process(self, intake_id, owner, retry_failed):
        item = self.get(intake_id)
        if item["mode"] != "linked_folder" and not item.get("project_id"):
            if item["mode"] == "zip_upload":
                self._update(intake_id, owner, "extracting")
                self._extract(intake_id, owner)
            registered = self.workspace.ensure_folder_project(self._folder(intake_id)/"sources", item["name"], item.get("requested_project_id"))
            self._update(intake_id, owner, project_id=registered["project"]["project_id"], source_root=registered["project"]["source_root"])
        project = self.get(intake_id)["project_id"]
        self._update(intake_id, owner, "indexing", error=None)
        last_progress = [0]
        last_phase = [None]
        def progress(**values):
            if values.get("phase") == "indexing" or values.get("phase") != last_phase[0] or time.monotonic()-last_progress[0] >= .75:
                self._update(intake_id, owner, **values); last_progress[0] = time.monotonic(); last_phase[0] = values.get("phase")
        from .ingest import scan
        while True:
            result = scan(self.workspace, project, 10000, retry_failed=retry_failed, progress=progress)
            retry_failed = False
            self._update(intake_id, owner, coverage=result["status"]["coverage"], counts=result["status"]["counts"],
                         reading_work=result["status"]["reading_work"], remaining=result["remaining_in_batch"], errors=result["errors"][:20])
            if not result["remaining_in_batch"]:
                break
        coverage = result["status"]["coverage"]
        with connection(self.workspace.db_path(project), readonly=True) as db:
            errors = [dict(r) for r in db.execute("select doc_id,relative_path,sha256,error from documents where index_status='parse_failed' order by relative_path limit 20")]
        partial = any(coverage.get(s,0) for s in ("parse_failed", "empty_text", "pending", "source_missing", "unsupported")) or result["status"]["reading_work"]["counts"].get("low_text_blocks",0) > 0
        self._update(intake_id, owner, "partial" if partial else "ready", completed_at=now(), current_document=None,
                     errors=errors, coverage=coverage,
                     next_tools=["project_status", "find_documents", "read_evidence", "record_observations"])

