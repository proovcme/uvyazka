import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from uvyazka.core import Workspace, compare_quantity, connection
from uvyazka.demo import create_demo
from uvyazka.ingest import scan


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Workspace(Path(self.temp.name) / "state")
        create_demo(self.workspace)

    def test_two_projects_and_exact_locators(self):
        a = self.workspace.get_evidence_chain("demo-a", "area-design")["fact"]
        b = self.workspace.get_evidence_chain("demo-b", "area-design")["fact"]
        self.assertEqual((a["value"], b["value"]), ("12", "8"))
        source = a["sources"][0]
        page = self.workspace.read_evidence("demo-a", source["doc_id"], source["page_number"])
        self.assertEqual(page["locator"], {"kind": "text_line", "line": 2})
        with self.assertRaises(ValueError):
            self.workspace.read_evidence("demo-b", source["doc_id"])
        with self.assertRaises(ValueError):
            self.workspace.project("../demo-a")

    def test_demo_repeat_preserves_sources_and_freshness(self):
        root = Path(self.workspace.project("demo-a")["source_root"])
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()}
        create_demo(self.workspace)
        self.assertEqual(before, {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()})
        self.assertEqual(self.workspace.project_status("demo-a")["questions"], 1)

    def test_semantics_units_and_decimal_arithmetic(self):
        a = {"entity": "element", "property": "volume", "basis": "net", "revision_set": "1", "specification": "B25", "value": "0.2", "unit": "100 m3"}
        b = {**a, "value": "20", "unit": "m3"}
        self.assertEqual(compare_quantity(a, b)["status"], "matches")
        self.assertEqual(compare_quantity(a, {**b, "value": "19.9"})["difference"], "-0.1")
        self.assertEqual(compare_quantity(a, {**b, "basis": "supply"})["status"], "question")
        self.assertEqual(compare_quantity(a, {**b, "specification": "B20"})["status"], "question")
        self.assertEqual(compare_quantity(a, {**b, "value": None})["status"], "not_comparable")
        for value in ("NaN", "Infinity", "1e999999"):
            with self.assertRaises(ValueError):
                compare_quantity(a, {**b, "value": value})
        with self.assertRaises(ValueError):
            compare_quantity(a, b, "-1")

    def test_incremental_hash_and_historical_evidence(self):
        fact = self.workspace.get_evidence_chain("demo-a", "area-design")["fact"]
        s = fact["sources"][0]
        record, path = self.workspace.source_record("demo-a", s["doc_id"])
        stat = path.stat(); original_hash = record["sha256"]
        path.write_text(path.read_text(encoding="utf-8").replace("12 м2", "13 м2"), encoding="utf-8")
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        result = scan(self.workspace, "demo-a")
        self.assertEqual(len(result["processed"]), 1)
        old = self.workspace.read_evidence("demo-a", s["doc_id"], 2, sha256=original_hash)
        self.assertIn("12 м2", old["text"]); self.assertEqual(old["freshness"]["status"], "historical_snapshot")
        current = self.workspace.read_evidence("demo-a", s["doc_id"], 2)
        self.assertIn("13 м2", current["text"])
        self.assertTrue(self.workspace.get_reconciliation("demo-a", "needs_review")["checks"])
        self.assertEqual(scan(self.workspace, "demo-a")["processed"], [])

    def test_parser_update_keeps_the_original_evidence_version(self):
        source = self.workspace.get_evidence_chain("demo-a", "area-design")["fact"]["sources"][0]
        old = self.workspace.read_evidence("demo-a", source["doc_id"], 2)
        with patch("uvyazka.ingest.revision_for", return_value="synthetic-parser-v2"):
            scan(self.workspace, "demo-a")
        current = self.workspace.read_evidence("demo-a", source["doc_id"], 2)
        historical = self.workspace.read_evidence("demo-a", source["doc_id"], 2,
            sha256=source["sha256"], parser_revision=old["parser_revision"])
        self.assertEqual(current["parser_revision"], "synthetic-parser-v2")
        self.assertEqual(historical["text"], old["text"])
        self.assertEqual(historical["freshness"]["status"], "historical_snapshot")
        self.assertEqual(self.workspace.project_status("demo-a")["questions"], 2)

    def test_atomic_batch_and_idempotent_retry(self):
        fact = self.workspace.get_evidence_chain("demo-a", "area-design")["fact"]
        new = {**fact, "id": "extra", "status": "source_observation"}
        new.pop("source_freshness"); new.pop("revision_approved")
        bad = {**new, "id": "invalid", "raw_value": "This literal is absent"}
        with self.assertRaises(ValueError):
            self.workspace.record_observations("demo-a", [new, bad], "rejected")
        self.assertEqual(len(self.workspace.get_project_facts("demo-a")["facts"]), 4)
        first = self.workspace.record_observations("demo-a", [new], "retry")
        self.assertEqual(first, self.workspace.record_observations("demo-a", [new], "retry"))
        with self.assertRaises(ValueError):
            self.workspace.record_observations("demo-a", [{**new, "name": "Changed"}], "retry")

    def test_failed_old_parser_cannot_override_another_registration(self):
        root = Path(self.workspace.project("demo-a")["source_root"])
        target = root / "new.txt"
        target.write_text("Synthetic parser handover", encoding="utf-8")
        def handover(_):
            with connection(self.workspace.db_path("demo-a")) as db:
                db.execute("update documents set parser_revision='another-reader' where relative_path='new.txt'")
            raise ValueError("Previous reader stopped")
        with patch("uvyazka.ingest.read_blocks", side_effect=handover):
            result = scan(self.workspace, "demo-a")
        self.assertEqual(len(result["errors"]), 1)
        record = self.workspace.find_documents("demo-a", "new.txt")["documents"][0]
        self.assertEqual((record["parser_revision"], record["index_status"]), ("another-reader", "pending"))

    def test_correction_history_and_dependent_checks(self):
        fact = self.workspace.get_evidence_chain("demo-a", "area-design")["fact"]
        changed = {**fact, "value": "120", "expected_revision": 1, "correction_reason": "Synthetic normalization error exercise"}
        changed.pop("source_freshness"); changed.pop("revision_approved")
        self.workspace.record_observations("demo-a", [changed], "correction")
        chain = self.workspace.get_evidence_chain("demo-a", "area-design")
        self.assertEqual([f["value"] for f in chain["history"]], ["12", "120"])
        self.assertEqual(chain["checks"][0]["status"], "needs_review")
        with self.assertRaises(ValueError):
            self.workspace.record_observations("demo-a", [changed], "stale-correction")

    def test_stale_sources_reject_writes(self):
        fact = self.workspace.get_evidence_chain("demo-a", "area-design")["fact"]
        _, path = self.workspace.source_record("demo-a", fact["sources"][0]["doc_id"])
        path.write_text("Changed source", encoding="utf-8")
        self.assertEqual(self.workspace.project_status("demo-a")["questions"], 2)
        candidate = {**fact, "id": "new"}; candidate.pop("revision_approved")
        with self.assertRaises(ValueError):
            self.workspace.record_observations("demo-a", [candidate], "stale")

    def test_unsupported_missing_and_source_safety(self):
        root = Path(self.workspace.project("demo-a")["source_root"])
        (root / "drawing.dwg").write_bytes(b"synthetic unsupported format")
        scan(self.workspace, "demo-a")
        documents = self.workspace.find_documents("demo-a", "drawing")["documents"]
        self.assertEqual(documents[0]["index_status"], "unsupported")
        (root / "drawing.dwg").unlink()
        scan(self.workspace, "demo-a")
        self.assertEqual(self.workspace.find_documents("demo-a", "drawing")["documents"][0]["index_status"], "source_missing")
        with self.assertRaises(ValueError):
            self.workspace.create_project("nested", "Invalid", self.workspace.home.parent)

    def test_source_reads_and_queries_do_not_modify_originals(self):
        root = Path(self.workspace.project("demo-a")["source_root"])
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
        self.workspace.search_project("demo-a", '"; DROP TABLE facts; --')
        self.assertTrue(self.workspace.search_project("demo-a", "бетон")["results"])
        self.workspace.get_project_facts("demo-a")
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()})


if __name__ == "__main__":
    unittest.main()
