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


class DashboardTests(unittest.TestCase):
    def test_concurrent_scope_readonly_and_host(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Workspace(Path(td) / "state"); create_demo(workspace)
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
                    self.assertIn("Увязка", response.read().decode())
            finally:
                server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
