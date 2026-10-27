"""Desktop shell endpoints: explicit MCP setup and backup before app updates."""
from __future__ import annotations
import json
import os
from pathlib import Path
import sqlite3
import sys
from contextlib import closing
from datetime import datetime,timezone
from .core import connection

ORIGINS={'http://tauri.localhost','https://tauri.localhost','tauri://localhost'}


def clients(workspace):
    frozen=getattr(sys,'frozen',False)
    exe=str(Path(sys.executable).resolve());args=['--mcp'] if frozen else ['-m','uvyazka.server']
    env={'UVYAZKA_HOME':str(workspace.home)}
    return {'Codex':'[mcp_servers.uvyazka]\ncommand = '+json.dumps(exe)+'\nargs = '+json.dumps(args)+'\n\n[mcp_servers.uvyazka.env]\nUVYAZKA_HOME = '+json.dumps(str(workspace.home))+'\n',
        'Claude / Gemini':json.dumps({'mcpServers':{'uvyazka':{'command':exe,'args':args,'env':env}}},ensure_ascii=False,indent=2)}


def gate(workspace):
    sessions=workspace.home/'desktop-sessions';active=[]
    if sessions.is_dir():
        for path in sessions.glob('mcp-*.json'):
            try:
                record=json.loads(path.read_text());pid=int(record['pid'])
                if os.name=='nt':
                    import ctypes
                    kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.OpenProcess.restype=ctypes.c_void_p
                    handle=kernel.OpenProcess(0x1000,False,pid)
                    alive=False
                    if handle:
                        code=ctypes.c_ulong();alive=bool(kernel.GetExitCodeProcess(ctypes.c_void_p(handle),ctypes.byref(code))) and code.value==259;kernel.CloseHandle(ctypes.c_void_p(handle))
                else:
                    try:os.kill(pid,0);alive=True
                    except ProcessLookupError:alive=False
                if alive:active.append(record)
            except (ValueError,OSError,KeyError,json.JSONDecodeError):active.append({'state':'unread_session'})
    if active:return {'ready':False,'reason':'Отключите MCP Увязки в ИИ-клиенте перед обновлением: активный процесс использует установленное ядро. Проекты останутся сохранены.','sessions':len(active)}
    from .construction.clash_jobs import ClashJobs
    import threading
    if any(t.is_alive() and t.name=='uvyazka-rvt-upload' for t in threading.enumerate()):
        return {'ready':False,'reason':'Дождитесь завершения чтения / конверсии RVT.'}
    for project in workspace.list_projects().get('projects',[]):
        for job in ClashJobs(workspace).list(project['project_id'],100)['items']:
            if job['status'] in {'queued','running'} and (datetime.now(timezone.utc)-datetime.fromisoformat(job['heartbeat'])).total_seconds()<180:
                return {'ready':False,'reason':'Завершите или отмените активные проверки перед обновлением.'}
    # Other background jobs are not cancelled just to replace the executable.
    from .intake import ProjectIntake
    try:
        if any(i.get('running') for i in ProjectIntake(workspace).get(limit=40).get('items',[])):
            return {'ready':False,'reason':'Дождитесь завершения приёма проекта перед обновлением.'}
    except (ValueError,KeyError):pass
    return {'ready':True}


def backup(workspace):
    ready=gate(workspace)
    if not ready['ready']:raise ValueError(ready['reason'])
    root=workspace.home/'backups'/('desktop-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'));root.mkdir(parents=True,exist_ok=False)
    paths=[workspace.registry]+list((workspace.home/'projects').glob('*/project.sqlite3'))
    for path in paths:
        target=root/path.relative_to(workspace.home);target.parent.mkdir(parents=True,exist_ok=True)
        with closing(sqlite3.connect(path)) as source,closing(sqlite3.connect(target)) as dest:
            source.backup(dest)
    metadata={'path':str(root),'databases':len(paths),'schema_change':'Additive tables only in this release; no destructive project migrations','created_at':datetime.now(timezone.utc).isoformat()}
    (root/'backup.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
    return metadata


def serve_get(handler,workspace,token,path):
    if not path.startswith('/api/desktop/'):return False
    if not getattr(handler.server,'desktop_embed',False):handler.send({'error':'Desktop shell route is disabled'},status=404);return True
    if path=='/api/desktop/config':handler.send({'clients':clients(workspace),'storage':str(workspace.home),'external_model_api':False})
    elif path=='/api/desktop/licenses':
        root=Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parents[2]))
        folder=root/'uvyazka-runtime/licenses'
        notice=folder/'DESKTOP-NOTICE.md';catalog=folder/'sources.lock.json'
        if not notice.is_file():notice=root/'desktop/THIRD_PARTY.md';catalog=root/'desktop/sources.lock.json'
        handler.send({'notice':notice.read_text(encoding='utf-8'),'sources':json.loads(catalog.read_text()),'release':'https://github.com/proovcme/uvyazka/releases/tag/v0.4.0-alpha.1','bundled_source':getattr(sys,'frozen',False)})
    elif path=='/api/desktop/source.zip':
        root=Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parents[2]))
        source=root/'uvyazka-runtime/sources/uvyazka-source.zip'
        if not source.is_file():handler.send({'error':'Bundled source archive is available in the installed build'},status=404)
        else:handler.send(source.read_bytes(),'application/zip')
    elif path=='/api/desktop/update-ready':handler.send({**gate(workspace),'token':token})
    else:handler.send({'error':'Desktop route not found'},status=404)
    return True
