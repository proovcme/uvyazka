"""Browser writes and MCP reads share one versioned store; cross-origin writes fail."""
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import test_measurements as fixtures
from uvyazka.dashboard import make_handler
from uvyazka.measurements import Measurements


@unittest.skipIf(fixtures.pymupdf is None, "readers extra not installed")
class MeasurementHttpTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MeasurementTests()
        self.fixture.setUp()
        self.workspace = self.fixture.workspace
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.workspace))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)
        self.token = self.get("runtime")["write_token"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.fixture.tearDown()

    def get(self, key, project="test", **query):
        with urlopen(self.base+"/api/measurements/"+key+"?"+urlencode({"project_id": project, **query})) as r:
            return json.load(r)

    def post(self, key, body, project="test", **headers):
        request = Request(self.base+"/api/measurements/"+key+"?project_id="+project,
                          data=json.dumps(body).encode(),
                          headers={"Content-Type": "application/json", "X-Uvyazka-Token": self.token,
                                   "Origin": self.base, **headers})
        with urlopen(request) as r:
            return json.load(r)

    def test_browser_to_mcp_scale_change_history_and_idempotence(self):
        body = {"view_id": "plan", "view_revision": 1, "calibration_revision": 1,
                "items": [self.fixture.item()], "request_id": "browser-area"}
        first = self.post("measure", body)
        self.assertEqual(first, self.post("measure", body))
        record = first["measurements"][0]
        self.assertEqual((record["value"], record["created_by"]), (100, "user"))
        mcp = Measurements(self.workspace, "test")
        self.assertEqual(mcp.context("measurement")["items"][0]["id"], record["id"])
        mcp.calibrate("plan", 1, 1, [[30, 60], [130, 60]], 20, "New control", "agent-control")
        self.assertIn("calibration_changed", self.get("context", kind="measurement")["items"][0]["stale_reasons"])
        with self.assertRaises(HTTPError):
            self.post("measure", {**body, "request_id": "stale"})
        self.post("recalculate", {"view_id": "plan", "view_revision": 1, "calibration_revision": 2,
                                 "items": [{"id": "floor", "expected_revision": 1}],
                                 "reason": "Control checked in viewer", "request_id": "browser-recalc"})
        history = self.get("context", kind="measurement", record_id="floor", history="1")["items"]
        self.assertEqual([r["value"] for r in history], [100, 400])
        result = self.get("render", doc_id=self.fixture.doc_id, sha256=self.fixture.sha,
                          view_id="plan", measurement_ids="floor")
        self.assertTrue(result["image"].startswith("data:image/png;base64,iVBOR"))
        self.assertEqual(result["metadata"]["rendered"][0]["revision"], 2)
        self.assertEqual(self.fixture.file.read_bytes(), self.fixture.original)

    def test_protected_routes_validate_inputs_and_project(self):
        body = {"view_id": "plan", "view_revision": 1, "calibration_revision": 1,
                "items": [self.fixture.item()], "request_id": "browser-area"}
        for headers in [{"X-Uvyazka-Token": ""}, {"Origin": "https://attacker.invalid"},
                        {"Host": "attacker.invalid"}]:
            with self.assertRaises(HTTPError) as error:
                self.post("measure", body, **headers)
            self.assertEqual(error.exception.code, 403)
        for key, payload in [("measure", []), ("measure", {"unrecognized": True}), ("review", {}),
                             ("__dict__", {}), ("measure", {**body, "items": [{}]})]:
            with self.assertRaises(HTTPError) as error:
                self.post(key, payload)
            self.assertEqual(error.exception.code, 400)
        self.workspace.create_project("other", "Other", self.fixture.source)
        self.assertEqual(self.get("context", project="other", kind="measurement")["items"], [])
        with self.assertRaises(HTTPError):
            self.post("measure", body, project="other")
        self.assertEqual(self.get("context", kind="measurement")["total"], 0)
        with urlopen(self.base+"/measurements/") as response:
            self.assertIn("Лист и измерения", response.read().decode())
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])

    def test_browser_creates_view_and_calibration_with_user_provenance(self):
        view = {"id": "browser-view", "doc_id": self.fixture.doc_id, "sha256": self.fixture.sha,
                "page_number": 1, "name": "Browser region", "kind": "user_defined",
                "region": [10, 10, 290, 380], "measurement_basis": "Plan", "reason": "Selected frame"}
        saved = self.post("view", {"view": view, "expected_revision": 0, "request_id": "ui-view"})["view"]
        self.assertEqual(saved["interpretation_status"], "user_proposed")
        cal = self.post("calibration", {"view_id": view["id"], "expected_view_revision": 1,
                         "expected_calibration_revision": 0, "points": [[30, 60], [130, 60]],
                         "length_m": 10, "basis": "Printed dimension", "request_id": "ui-cal"})["calibration"]
        self.assertEqual((cal["created_by"], cal["status"]), ("user", "user_proposed"))
