import asyncio
import os
from pathlib import Path
import sys
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
    async def test_official_stdio_client_and_observation(self):
        await asyncio.wait_for(self.check_protocol(), timeout=60)

    async def check_protocol(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "state"; workspace = Workspace(home); create_demo(workspace)
            parameters = StdioServerParameters(command=sys.executable, args=["-m", "uvyazka.server"], env={**os.environ, "UVYAZKA_HOME": str(home), "PYTHONUTF8": "1"})
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    self.assertEqual(len(listed.tools), 30)
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
