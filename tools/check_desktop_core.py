"""Smoke-check the frozen executable and stdio protocol in disposable state."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]

if __name__=='__main__':
    binary=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'desktop/src-tauri/binaries/uvyazka-core-x86_64-pc-windows-msvc.exe'
    with tempfile.TemporaryDirectory(prefix='uvyazka-desktop-qa-') as temporary:
        env={**os.environ,'UVYAZKA_HOME':temporary}
        from uvyazka.core import Workspace
        from uvyazka.server import build_server
        expected={tool.name for tool in asyncio.run(build_server(Workspace(Path(temporary)/'reference')).list_tools())}
        result=subprocess.run([str(binary),'--self-check'],env=env,capture_output=True,text=True,encoding='utf-8',timeout=60)
        assert result.returncode==0,result.stderr
        report=json.loads(result.stdout)
        assert report['core']=='ok'
        from uvyazka.construction.model_tables import engine_sha
        assert report['table_engine_sha256']==engine_sha(), 'Frozen table engine differs from source'
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        async def check_protocol():
            # Keep stdin open until both replies arrive: EOF may cancel pending
            # requests and is not a valid replacement for the MCP handshake.
            params=StdioServerParameters(command=str(binary),args=['--mcp'],env=env)
            async with stdio_client(params) as (read,write):
                async with ClientSession(read,write) as session:
                    await session.initialize()
                    return {tool.name for tool in (await session.list_tools()).tools}
        actual=asyncio.run(asyncio.wait_for(check_protocol(),timeout=60))
        assert actual==expected,{'missing':sorted(expected-actual),'unexpected':sorted(actual-expected)}
        assert not list((Path(temporary)/'desktop-sessions').glob('mcp-*.json')), 'MCP lease was not cleaned up'
    print(f'Frozen core: readers/native RVT imports, {len(expected)} MCP tools matching source, UTF-8 responses and clean shutdown OK')
