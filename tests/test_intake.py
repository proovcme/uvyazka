from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from uvyazka.core import Workspace, connection
from uvyazka.intake import ProjectIntake


TEXT = "Synthetic project: room 101 has floor area 12 m2. " * 4


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.source = self.root / "sources"; self.source.mkdir()
        (self.source / "AR.txt").write_text(TEXT, encoding="utf-8")
        self.ws = Workspace(self.root / "state"); self.intake = ProjectIntake(self.ws)

    def test_same_folder_converges_across_clients_and_retains_observations(self):
        def register(_):
            return ProjectIntake(Workspace(self.ws.home)).import_folder(self.source, "Synthetic", background=False)
        with ThreadPoolExecutor(max_workers=4) as pool:
            registered = list(pool.map(register, range(8)))
        self.assertEqual(len({j["project_id"] for j in registered}), 1)
        self.assertEqual(len({j["intake_id"] for j in registered}), 1)
        job = registered[0]; result = self.intake.run(job["intake_id"])
        self.assertEqual(result["status"], "ready", result)
        project = job["project_id"]; doc = self.ws.find_documents(project)["documents"][0]
        evidence = self.ws.read_evidence(project, doc["doc_id"])
        fact = {"id":"room-area", "name":"Area", "group":"rooms", "value":"12", "raw_value":"12", "unit":"m2", "basis":"floor",
                "sources":[{"doc_id":doc["doc_id"], "sha256":doc["sha256"], "page_number":1, "parser_revision":evidence["parser_revision"]}]}
        self.ws.record_observations(project, [fact], "model-recorded")
        original = (self.source/"AR.txt").read_bytes()
        next_job = ProjectIntake(Workspace(self.ws.home)).import_folder(self.source, background=False)
        self.assertTrue(next_job["project_reused"])
        self.intake.run(next_job["intake_id"])
        self.assertEqual(self.ws.get_project_facts(project)["facts"][0]["id"], "room-area")
        self.assertEqual((self.source/"AR.txt").read_bytes(), original)
        (self.source/"AR.txt").write_text(TEXT.replace("12", "13"), encoding="utf-8")
        self.intake.run(next_job["intake_id"])
        self.assertIn("12", self.ws.read_evidence(project,doc["doc_id"],sha256=doc["sha256"])["text"])
        self.assertEqual(self.ws.get_project_facts(project)["facts"][0]["revision"], 1)
        self.assertNotIn("snapshot_metadata_matches", self.ws.get_project_facts(project)["facts"][0]["source_freshness"].values())

    def test_partial_folder_upload_survives_restart_and_mcp_uses_same_project(self):
        payload = TEXT.encode(); job = self.intake.begin_upload("folder_upload", "Folder", [{"path":"ПД/АР.txt","size":len(payload)}, {"path":"РД/empty.csv","size":0}])
        key=job["intake_id"]
        self.intake.receive_file(key,"ПД/АР.txt",len(payload),io.BytesIO(payload))
        restarted=ProjectIntake(Workspace(self.ws.home))
        self.assertEqual(restarted.get(key)["received_files"],1)
        with self.assertRaises(ValueError): restarted.finish_folder(key, background=False)
        with self.assertRaises(ValueError): restarted.receive_file(key,"unexpected.txt",len(payload),io.BytesIO(payload))
        restarted.receive_file(key,"РД/empty.csv",0,io.BytesIO())
        restarted.finish_folder(key,background=False); result=restarted.run(key)
        self.assertEqual(result["status"],"partial")
        registered=restarted.import_folder(result["source_root"],background=False)
        self.assertEqual(registered["project_id"],result["project_id"])
        self.assertEqual(self.ws.project_status(result["project_id"])["counts"]["documents"],2)

    def archive(self, entries):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,"w",zipfile.ZIP_DEFLATED) as archive:
            for name, content in entries:
                if isinstance(name, str):
                    info = zipfile.ZipInfo()
                    info.filename = info.orig_filename = name
                    name = info
                archive.writestr(name,content)
        return stream.getvalue()

    def test_zip_preserves_tree_and_records_unsupported_formats_separately(self):
        raw=self.archive([("ПД/АР.txt",TEXT),("РД/model.rvt",b"synthetic RVT")])
        job=self.intake.begin_upload("zip_upload","ZIP",project_id="from-zip")
        self.intake.receive_archive(job["intake_id"],len(raw),io.BytesIO(raw),background=False)
        result=ProjectIntake(Workspace(self.ws.home)).run(job["intake_id"])
        self.assertEqual(result["project_id"],"from-zip")
        self.assertEqual(result["coverage"],{"text_indexed":1,"unsupported":1})
        self.assertEqual(result["status"],"partial")
        docs=self.ws.find_documents("from-zip")["documents"]
        self.assertEqual({d["relative_path"] for d in docs},{"ПД/АР.txt","РД/model.rvt"})
        with self.assertRaises(ValueError): self.intake.get(job["intake_id"], self.intake.import_folder(self.source,background=False)["project_id"])

    def test_zip_rejects_unsafe_entries_before_extracting_or_registering(self):
        for bad in ("../escape.txt","/escape.txt","C:/escape.txt","a\\b.txt","CON.txt","a.txt:stream","a/../escape.txt","a./x"):
            with self.subTest(path=bad):
                raw=self.archive([("valid.txt",TEXT),(bad,TEXT)])
                job=self.intake.begin_upload("zip_upload","Bad archive")
                self.intake.receive_archive(job["intake_id"],len(raw),io.BytesIO(raw),background=False)
                result=self.intake.run(job["intake_id"])
                self.assertEqual(result["status"],"failed",result)
                self.assertIsNone(result["project_id"])
                self.assertEqual(list((self.intake._folder(job["intake_id"])/"sources").rglob("*")),[])
        self.assertEqual(self.ws.list_projects()["projects"],[])

    def test_zip_rejects_links_case_collisions_and_file_directory_conflicts(self):
        link=zipfile.ZipInfo("linked.txt");link.create_system=3;link.external_attr=(stat.S_IFLNK|0o777)<<16
        for entries in ([('A.txt',TEXT),('a.txt',TEXT)], [('a',TEXT),('a/b.txt',TEXT)],[(link,'../escape')]):
            raw=self.archive(entries);job=self.intake.begin_upload("zip_upload","Conflicting archive")
            self.intake.receive_archive(job["intake_id"],len(raw),io.BytesIO(raw),background=False)
            self.assertEqual(self.intake.run(job["intake_id"])["status"],"failed")

    def test_failed_transfer_does_not_publish_file_and_can_be_retried(self):
        job=self.intake.begin_upload("folder_upload","Interrupted",[{"path":"AR.txt","size":len(TEXT)}]); key=job["intake_id"]
        with self.assertRaises(ValueError):self.intake.receive_file(key,"AR.txt",len(TEXT),io.BytesIO(b"short"))
        self.assertEqual(self.intake.get(key)["received_files"],0)
        self.assertFalse(list(self.intake._folder(key).rglob("*.part")))
        self.intake.receive_file(key,"AR.txt",len(TEXT),io.BytesIO(TEXT.encode()))
        self.intake.finish_folder(key,background=False)
        self.assertEqual(self.intake.run(key)["status"],"ready")

    def test_active_worker_is_not_duplicated_and_expired_lease_resumes(self):
        job=self.intake.import_folder(self.source,background=False);key=job["intake_id"]
        with connection(self.ws.registry) as db:
            db.execute("update intake_jobs set status='indexing',owner='other',lease_until=9999999999 where intake_id=?",(key,))
        with patch('uvyazka.ingest.scan',side_effect=AssertionError('Must not duplicate worker')):
            self.assertTrue(self.intake.run(key)["running"])
        with connection(self.ws.registry) as db:
            db.execute("update intake_jobs set lease_until=0 where intake_id=?",(key,))
        self.assertTrue(ProjectIntake(Workspace(self.ws.home)).get(key)["can_resume"])
        self.assertEqual(self.intake.run(key)["status"],"ready")

    def test_bad_reader_does_not_starve_remaining_documents(self):
        (self.source/'broken.pdf').write_bytes(b'not pdf')
        job=self.intake.import_folder(self.source,background=False)
        result=self.intake.run(job['intake_id'])
        self.assertEqual(result['coverage'],{'parse_failed':1,'text_indexed':1})
        with patch('uvyazka.ingest.read_blocks',side_effect=AssertionError('Unchanged failures are not retried silently')):
            self.assertEqual(self.intake.run(job['intake_id'])['status'],'partial')

    def test_manifest_and_registration_conflicts_are_explicit(self):
        for relative in ("", ".", "sources"):
            with self.assertRaises(ValueError):self.intake.import_folder(relative,background=False)
        for files in ([{'path':'../bad','size':1}],[{'path':'a','size':1},{'path':'A','size':1}],[{'path':'a','size':1},{'path':'a/b','size':1}]):
            with self.assertRaises(ValueError):self.intake.begin_upload('folder_upload','Invalid',files)
        job=self.intake.import_folder(self.source,project_id='one',background=False)
        with self.assertRaises(ValueError):self.intake.import_folder(self.source,project_id='two',background=False)
        other=self.root/'other';other.mkdir()
        with self.assertRaises(ValueError):self.intake.import_folder(other,project_id='one',background=False)
        self.assertEqual(self.ws.project('one')['source_root'],str(self.source))
