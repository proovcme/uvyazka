"""Synthetic two-scale sheet: persistence, revisions, provenance and refusal."""
import hashlib
import tempfile
import unittest
from pathlib import Path

from uvyazka.core import Workspace, connection
from uvyazka.ingest import scan
from uvyazka.measurements import Measurements, geometry

try:
    import pymupdf
except ImportError:
    pymupdf = None


@unittest.skipIf(pymupdf is None, "readers extra not installed")
class MeasurementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.source = root/"sources"
        self.source.mkdir()
        self.file = self.source/"two-scales.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page(width=600, height=400)
            page.insert_text((25, 30), "PLAN - CONTROL 10 m")
            page.insert_text((325, 30), "DETAIL - CONTROL 0.5 m")
            for box in [(30, 60, 130, 160), (330, 60, 430, 160)]:
                page.draw_rect(box, color=(0, 0, 0))
            page.set_rotation(90)
            pdf.save(self.file)
        self.original = self.file.read_bytes()
        self.workspace = Workspace(root/"state")
        self.workspace.create_project("test", "Synthetic project", self.source)
        scan(self.workspace, "test")
        doc = self.workspace.find_documents("test")["documents"][0]
        self.doc_id, self.sha = doc["doc_id"], doc["sha256"]
        self.store = Measurements(self.workspace, "test")
        for key, region, length in [("plan", [10, 10, 290, 380], 10), ("detail", [310, 10, 590, 380], .5)]:
            view = {"id": key, "doc_id": self.doc_id, "sha256": self.sha, "page_number": 1,
                    "name": key, "kind": "plan" if key == "plan" else "detail", "region": region,
                    "measurement_basis": "planar_projection", "reason": "Synthetic separate view"}
            self.store.save_view(view, 0, "view-"+key)
            self.store.calibrate(key, 1, 0, [[region[0]+20, 60], [region[0]+120, 60]],
                                 length, "Known synthetic dimension", "scale-"+key)

    def tearDown(self):
        self.temp.cleanup()

    def item(self, key="floor", x=30):
        return {"id": key, "kind": "area", "name": key, "basis": "inner_floor_boundary",
                "points": [[x, 60], [x+100, 60], [x+100, 160], [x, 160]],
                "reason": "Model traced visible wall faces"}

    def test_two_views_persist_resume_recalibrate_and_review(self):
        a = self.store.measure("plan", 1, 1, [self.item()], "area-plan")["measurements"][0]
        b = self.store.measure("detail", 1, 1, [self.item("detail-area", 330)], "area-detail")["measurements"][0]
        self.assertAlmostEqual(a["value"], 100)
        self.assertAlmostEqual(b["value"], .25)
        reopened = Measurements(Workspace(self.workspace.home), "test")
        self.assertEqual(len(reopened.context("measurement")["items"]), 2)
        self.assertEqual(self.workspace.project_status("test")["drawing_work"]["counts"]["measurement"], 2)
        reopened.review([{"id": "floor", "expected_revision": 1, "verdict": "geometry_checked",
                          "note": "Compared rectangle with rendered source"}], "review")
        reopened.calibrate("plan", 1, 1, [[30, 60], [130, 60]], 20, "Corrected dimension", "scale-fix")
        self.assertIn("calibration_changed", reopened.context("measurement", record_id="floor")["items"][0]["stale_reasons"])
        self.assertEqual(reopened.context("measurement", record_id="detail-area")["items"][0]["stale_reasons"], [])
        fixed = reopened.recalculate("plan", 1, 2, [{"id": "floor", "expected_revision": 2}],
                                     "Control dimension corrected", "recalc")["measurements"][0]
        self.assertAlmostEqual(fixed["value"], 400)
        self.assertNotIn("review", fixed)
        self.assertEqual(fixed["status"], "calculated_unreviewed")
        history = reopened.context("measurement", record_id="floor", history=True)["items"]
        self.assertEqual([r["value"] for r in history], [100, 100, 400])
        self.assertEqual(self.file.read_bytes(), self.original)

    def test_failed_batch_is_atomic_and_retry_is_identical(self):
        bad = self.item("outside", 250)
        with self.assertRaises(ValueError):
            self.store.measure("plan", 1, 1, [self.item(), bad], "batch")
        self.assertEqual(self.store.context("measurement")["total"], 0)
        result = self.store.measure("plan", 1, 1, [self.item()], "batch")
        self.assertEqual(self.store.measure("plan", 1, 1, [self.item()], "batch"), result)
        with self.assertRaises(ValueError):
            self.store.measure("plan", 1, 1, [self.item("other")], "batch")
        self.assertEqual(self.store.context("measurement", history=True)["total"], 1)

    def test_revision_and_project_boundaries(self):
        self.store.measure("plan", 1, 1, [self.item()], "area")
        with self.assertRaises(ValueError):
            self.store.calibrate("plan", 1, 0, [[30, 60], [130, 60]], 2, "wrong revision", "stale")
        self.workspace.create_project("other", "Other", self.source)
        other = Measurements(self.workspace, "other")
        self.assertEqual(other.context()["total"], 0)
        with self.assertRaises(ValueError):
            other.measure("plan", 1, 1, [self.item()], "area")
        view = self.store.context(record_id="plan")["items"][0]
        fields = {k: view[k] for k in ["id", "doc_id", "sha256", "page_number", "name", "kind", "region", "measurement_basis", "reason"]}
        fields["region"] = [10, 10, 280, 380]
        self.store.save_view(fields, 1, "view-change")
        with self.assertRaises(ValueError):
            self.store.measure("plan", 2, 1, [self.item("new")], "new")
        self.store.calibrate("plan", 2, 1, [[30, 60], [130, 60]], 10, "New view control", "newscale")
        with self.assertRaises(ValueError):
            self.store.recalculate("plan", 2, 2, [{"id": "floor", "expected_revision": 1}], "Unsafe rebind", "bad")

    def test_source_changed_even_before_scan_and_history_survives(self):
        self.store.measure("plan", 1, 1, [self.item()], "area")
        self.file.write_bytes(self.original+b"\n% changed")
        row = self.store.context("measurement")["items"][0]
        self.assertIn("source_changed_or_unavailable", row["stale_reasons"])
        self.assertEqual(row["value"], 100)
        with self.assertRaises(ValueError):
            self.store.render(self.doc_id, self.sha, 1, "plan", ["floor"])
        with self.assertRaises(ValueError):
            self.store.measure("plan", 1, 1, [self.item("new")], "new")
        scan(self.workspace, "test")
        updated = self.workspace.find_documents("test")["documents"][0]
        old = self.store.context("view", record_id="plan")["items"][0]
        view = {k: old[k] for k in ["id", "doc_id", "page_number", "name", "kind", "region", "measurement_basis", "reason"]}
        self.store.save_view({**view, "sha256": updated["sha256"]}, 1, "new-source")
        history = self.store.context("view", record_id="plan", history=True)["items"]
        self.assertIn("source_changed_or_unavailable", history[0]["stale_reasons"])
        self.assertEqual(history[1]["stale_reasons"], [])
        self.assertIn("source_changed_or_unavailable", self.store.context("measurement")["items"][0]["stale_reasons"])

    def test_rotation_crop_overlay_coordinates_and_no_source_write(self):
        info = self.store.inspect(self.doc_id, self.sha)
        self.assertEqual(info["original_rotation"], 90)
        self.assertEqual(info["page_bounds"], [0, 0, 600, 400])
        self.assertIn("PLAN", [w["text"] for w in info["text"]])
        vectors = self.store.inspect(self.doc_id, self.sha, section="vectors", limit=1)
        self.assertEqual(vectors["next_offset"], 1)
        self.assertEqual(vectors["vectors"][0]["primitive"][0], "re")
        self.assertEqual(vectors["vectors"][0]["primitive"][1], [30, 60, 130, 160])
        self.store.measure("plan", 1, 1, [self.item()], "area")
        meta, png = self.store.render(self.doc_id, self.sha, 1, "plan", ["floor"])
        self.assertEqual(meta["region"], [10, 10, 290, 380])
        self.assertEqual(meta["pixel_size"], [560, 740])
        self.assertEqual(meta["pixel_origin_page_points"], [10, 10])
        self.assertEqual(meta["rendered"][0]["stale"], False)
        pix = pymupdf.Pixmap(png)
        # Lower edge is amber at the explicitly mapped point, separate from blue control dimension.
        x, y = [round((v-o)*meta["pixels_per_point"]) for v, o in zip([80, 160], meta["pixel_origin_page_points"])]
        red, green, blue = pix.pixel(x, y)[:3]
        self.assertGreater(red, green)
        self.assertGreater(green, blue)
        self.assertEqual(hashlib.sha256(self.file.read_bytes()).hexdigest(), self.sha)

    def test_context_pagination_and_question(self):
        self.store.measure("plan", 1, 1, [self.item("a"), self.item("b")], "areas")
        page = self.store.context("measurement", limit=1)
        self.assertEqual(page["next_offset"], 1)
        self.assertEqual(self.store.context("measurement", offset=1)["items"][0]["id"], "b")
        result = self.store.review([{"id": "a", "expected_revision": 1, "verdict": "question",
                                    "note": "Door opening boundary unresolved"}], "question")
        self.assertEqual(result["measurements"][0]["status"], "question")
        with connection(self.workspace.db_path("test"), readonly=True) as db:
            self.assertGreater(db.execute("select count(*) from events where kind='drawing_measurement'").fetchone()[0], 0)

    def test_cropbox_and_axis_aligned_vectors(self):
        cropped = self.source/"cropped.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page(width=600, height=400)
            page.draw_line((50, 80), (150, 80))
            page.draw_line((50, 80), (50, 180))
            page.set_cropbox(pymupdf.Rect(20, 30, 580, 390))
            page.set_rotation(270)
            pdf.save(cropped)
        scan(self.workspace, "test")
        doc = self.workspace.find_documents("test", "cropped")["documents"][0]
        info = self.store.inspect(doc["doc_id"], doc["sha256"], section="vectors")
        self.assertEqual(info["page_bounds"], [0, 0, 560, 360])
        self.assertEqual(info["original_rotation"], 270)
        self.assertEqual(len(info["vectors"]), 2)
        self.assertEqual(info["vectors"][0]["primitive"], ["l", [30, 50], [130, 50]])
        metadata, png = self.store.render(doc["doc_id"], doc["sha256"])
        pix = pymupdf.Pixmap(png)
        self.assertEqual(metadata["pixel_origin_page_points"], [0, 0])
        self.assertLess(pix.pixel(160, 100)[0], 80)  # unrotated horizontal line

    def test_concurrent_corrections_do_not_overwrite_each_other(self):
        from concurrent.futures import ThreadPoolExecutor
        self.store.measure("plan", 1, 1, [self.item()], "first")
        def correct(index):
            item = {**self.item(), "expected_revision": 1, "reason": "Correction "+str(index)}
            try:
                return Measurements(self.workspace, "test").measure("plan", 1, 1, [item], "correct-"+str(index))
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(correct, [1, 2]))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(self.store.context("measurement", history=True)["total"], 2)


class GeometryTests(unittest.TestCase):
    def test_reject_ambiguous_geometry_and_nonfinite_values(self):
        for points in [
            [[0, 0], [2, 2], [0, 2], [2, 0]],
            [[0, 0], [2, 0], [1, 0], [0, 2]],
            [[0, 0], [float("nan"), 0], [0, 2]],
            [[0, 0], [2, 0], [2, 2], [0, 0], [0, 2]],
        ]:
            with self.assertRaises(ValueError):
                geometry("area", points, [0, 0, 3, 3])

    def test_concave_polygon_and_polyline(self):
        _, perimeter, area = geometry("area", [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]], [0, 0, 3, 3])
        self.assertEqual(area, 5)
        self.assertEqual(perimeter, 12)
        self.assertEqual(geometry("length", [[0, 0], [3, 0], [3, 3]], [0, 0, 3, 3])[1], 6)


if __name__ == "__main__":
    unittest.main()
