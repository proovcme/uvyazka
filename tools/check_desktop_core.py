"""Smoke-check the frozen executable and stdio protocol in disposable state."""
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
        result=subprocess.run([str(binary),'--self-check'],env=env,capture_output=True,text=True,encoding='utf-8',timeout=60)
        assert result.returncode==0,result.stderr
        assert json.loads(result.stdout)['core']=='ok'
        messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'desktop-build-check','version':'1'}}},
                  {'jsonrpc':'2.0','method':'notifications/initialized'},{'jsonrpc':'2.0','id':2,'method':'tools/list'}]
        result=subprocess.run([str(binary),'--mcp'],input='\n'.join(map(json.dumps,messages))+'\n',env=env,capture_output=True,text=True,encoding='utf-8',timeout=60)
        assert result.returncode==0,result.stderr
        replies={row['id']:row for row in map(json.loads,result.stdout.splitlines())}
        assert len(replies[2]['result']['tools'])==96
        assert 'Traceback' not in result.stderr,result.stderr
    print('Frozen core: readers/native RVT imports, 96 MCP tools, UTF-8 responses and clean shutdown OK')
