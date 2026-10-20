import asyncio
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

from uvyazka.core import Workspace
from uvyazka.demo import create_demo

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
except ImportError:
    ClientSession = None


@unittest.skipIf(ClientSession is None, "MCP extra not installed")
class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_server_without_optional_bim_libraries(self):
        code = '''
import asyncio, importlib.abc, sys, tempfile
from pathlib import Path
class BlockBIM(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'numpy','ifcopenshell','ezdxf','PIL'}:
            raise ModuleNotFoundError(fullname)
sys.meta_path.insert(0, BlockBIM())
from uvyazka.core import Workspace
from uvyazka.server import build_server
with tempfile.TemporaryDirectory() as directory:
    server = build_server(Workspace(Path(directory)/'state'))
    assert len(asyncio.run(server.list_tools())) == 56
    asyncio.run(server.call_tool('construction_schema', {}))
    asyncio.run(server.call_tool('rvt_converter_status', {}))
'''
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    async def test_official_stdio_client_and_observation(self):
        await asyncio.wait_for(self.check_protocol(), timeout=60)

    async def test_drawing_work_survives_stdio_restart_and_returns_image(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest("readers extra not installed")
        from uvyazka.ingest import scan
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root/"sources"; source.mkdir()
            with pymupdf.open() as pdf:
                page = pdf.new_page(width=300, height=300)
                page.draw_rect((30, 50, 130, 150))
                pdf.save(source/"plan.pdf")
            workspace = Workspace(root/"state")
            workspace.create_project("drawing", "Synthetic", source)
            scan(workspace, "drawing")
            doc = workspace.find_documents("drawing")["documents"][0]
            scope = {"project_id": "drawing"}
            source_args = {**scope, "doc_id": doc["doc_id"], "sha256": doc["sha256"]}
            params = StdioServerParameters(command=sys.executable, args=["-m", "uvyazka.server"],
                env={**os.environ, "UVYAZKA_HOME": str(workspace.home), "PYTHONUTF8": "1"})
            # These are separate server processes, not two handles to in-memory state.
            for phase in (0, 1):
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        async def call(name, **args):
                            result = await session.call_tool(name, {**scope, **args})
                            self.assertFalse(result.isError, (name, result))
                            return result
                        if phase == 0:
                            await call("inspect_measurement_sheet", doc_id=doc["doc_id"], sha256=doc["sha256"])
                            await call("save_drawing_view", view={
                                "id": "plan", "doc_id": doc["doc_id"], "sha256": doc["sha256"], "page_number": 1,
                                "region": [10, 10, 290, 290], "name": "Plan", "kind": "plan",
                                "measurement_basis": "planar", "reason": "Synthetic view"},
                                expected_revision=0, request_id="view")
                            await call("calibrate_drawing_view", view_id="plan", expected_view_revision=1,
                                expected_calibration_revision=0, points=[[30, 50], [130, 50]],
                                length_m=10, basis="Known 10 m dimension", request_id="scale")
                            await call("measure_drawing_view", view_id="plan", view_revision=1,
                                calibration_revision=1, items=[{"id": "edge", "name": "Edge", "kind": "length",
                                "points": [[30, 50], [130, 50]], "basis": "wall_face", "reason": "Visible edge"}],
                                request_id="measure")
                        else:
                            result = await call("get_drawing_measurements", kind="measurement")
                            data = json.loads(next(c.text for c in result.content if c.type == "text"))
                            self.assertEqual(data["items"][0]["value"], 10)
                            self.assertEqual(data["items"][0]["stale_reasons"], [])
                            result = await call("render_drawing_measurements", **{k:v for k,v in source_args.items() if k != "project_id"},
                                                view_id="plan", measurement_ids=["edge"])
                            self.assertTrue(any(c.type == "image" and c.mimeType == "image/png" for c in result.content))

    async def check_protocol(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "state"; workspace = Workspace(home); create_demo(workspace)
            parameters = StdioServerParameters(command=sys.executable, args=["-m", "uvyazka.server"], env={**os.environ, "UVYAZKA_HOME": str(home), "PYTHONUTF8": "1"})
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    self.assertEqual(len(listed.tools), 56)
                    by_name = {tool.name: tool for tool in listed.tools}
                    self.assertTrue(by_name["read_evidence"].annotations.readOnlyHint)
                    self.assertFalse(by_name["record_observations"].annotations.readOnlyHint)
                    for name, arguments in [("list_projects", {}), ("project_status", {"project_id": "demo-a"}), ("search_project", {"project_id": "demo-a", "query": "бетон"}), ("get_reconciliation", {"project_id": "demo-a"}), ("list_technology_sources", {"query": "04.02"})]:
                        result = await session.call_tool(name, arguments)
                        self.assertFalse(result.isError, (name, result))
                    fact = workspace.get_evidence_chain("demo-a", "area-design")["fact"]
                    item = {k: fact[k] for k in ["name", "group", "value", "raw_value", "unit", "basis", "sources", "entity", "property", "revision_set"]}
                    item["id"] = "mcp-recorded"
                    args = {"project_id": "demo-a", "observations": [item], "request_id": "mcp-test"}
                    result = await session.call_tool("record_observations", args)
                    self.assertFalse(result.isError, result)
                    self.assertFalse((await session.call_tool("record_observations", args)).isError)
                    self.assertEqual(workspace.get_evidence_chain("demo-a", "mcp-recorded")["fact"]["value"], "12")
                    scenario = {"id":"stdio-schedule","name":"Stdio schedule","resources":[],"operations":[{"id":"work","name":"Work","duration":10,"evidence":{"kind":"assumed","reason":"Protocol test"}}]}
                    for name, arguments in [
                        ("construction_schema", {}), ("list_project_checks", {}),
                        ("save_construction_scenario", {"project_id":"demo-a","scenario":scenario,"request_id":"stdio-save"}),
                        ("run_construction_scenario", {"project_id":"demo-a","scenario_id":"stdio-schedule"}),
                        ("save_project_graph", {"project_id":"demo-a","request_id":"stdio-graph","graph":{"entities":[{"id":"room","kind":"room","name":"Room"}]}}),
                        ("audit_project_graph", {"project_id":"demo-a"})]:
                        result = await session.call_tool(name, arguments)
                        self.assertFalse(result.isError, (name,result))
                    error = await session.call_tool("project_status", {"project_id": "nonexistent"})
                    self.assertTrue(error.isError)


if __name__ == "__main__":
    unittest.main()
