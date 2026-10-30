from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

from uvyazka.core import Workspace
from uvyazka.demo import create_demo
from uvyazka.dashboard import make_handler
from uvyazka.construction.demo import create_engineering_demo
from uvyazka.construction.planning import Planning
from uvyazka.coordination import Coordination


class DashboardTests(unittest.TestCase):
    def test_concurrent_scope_readonly_and_host(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Workspace(Path(td) / "state"); create_demo(workspace)
            create_engineering_demo(workspace)
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(workspace))
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            base = "http://127.0.0.1:" + str(server.server_port)
            try:
                def check(key):
                    with urlopen(base + "/api/facts?project_id=" + key) as response:
                        result = json.load(response)
                    self.assertEqual(result["project_id"], key)
                    return next(f["value"] for f in result["facts"] if f["id"] == "area-design")
                keys = ["demo-a", "demo-b"] * 8
                with ThreadPoolExecutor(max_workers=6) as pool:
                    self.assertEqual(list(pool.map(check, keys)), ["12" if k == "demo-a" else "8" for k in keys])
                with self.assertRaises(HTTPError) as error:
                    urlopen(base + "/api/facts?project_id=unknown")
                self.assertEqual(error.exception.code, 400)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/api/facts", data=b"{}", method="POST"))
                self.assertEqual(error.exception.code, 405)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/api/projects", headers={"Host": "unexpected.invalid"}))
                self.assertEqual(error.exception.code, 403)
                with urlopen(base + "/") as response:
                    html=response.read().decode();self.assertIn("Увязка", html)
                    self.assertLess(html.index('/language.js'),html.index('/rvt.js'))
                with urlopen(base + '/language.js') as response:
                    self.assertIn('userMessage',response.read().decode())
                run=Planning(workspace).list_runs("demo-a")["items"][0]
                with urlopen(base + "/api/construction/run?project_id=demo-a&run_id="+run["run_id"]) as response:
                    self.assertEqual(json.load(response)["duration"],600)
                with self.assertRaises(HTTPError):
                    urlopen(base + "/api/construction/run?project_id=demo-b&run_id="+run["run_id"])
                with urlopen(base + "/api/construction/schedule.csv?project_id=demo-a&run_id="+run["run_id"]) as response:
                    self.assertTrue(response.read().startswith(b"\xef\xbb\xbf"))
                audit=Coordination(workspace).audits("demo-a")["items"][0]
                with urlopen(base + "/api/coordination/issues?project_id=demo-a&audit_id="+audit["audit_id"]+"&limit=2") as response:
                    findings=json.load(response)
                    self.assertEqual(len(findings["items"]),2)
                    self.assertEqual(sum(findings["finding_counts"].values()),findings['issue_count'])
                with urlopen(base + "/api/coordination/issues?project_id=demo-a&audit_id="+audit["audit_id"]+"&category=unchecked") as response:
                    filtered=json.load(response)
                    self.assertEqual(filtered['category_filter'],'unchecked')
                    self.assertTrue(all(item['category']=='unchecked' for item in filtered['items']))
                with urlopen(base + "/simulation/") as response:
                    self.assertIn("Увязка",response.read().decode())
                # A read-only request must not migrate the untouched second project's DB.
                before=workspace.db_path("demo-b").read_bytes()
                with urlopen(base + "/api/coordination/audits?project_id=demo-b") as response:
                    self.assertEqual(json.load(response),{"items":[]})
                self.assertEqual(before,workspace.db_path("demo-b").read_bytes())
            finally:
                server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
