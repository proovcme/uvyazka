"""Bundled local core entry. Same package/database as MCP and the browser panel."""
import argparse
import atexit
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
from uuid import uuid4


def main():
    import multiprocessing
    multiprocessing.freeze_support()
    if '--mcp' in sys.argv:
        os.environ.setdefault('PYMUPDF_MESSAGE','fd:2')
        os.environ.setdefault('PYMUPDF_LOG','fd:2')
    from uvyazka.core import Workspace,default_home
    root=Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parent))
    native=root/'uvyazka-runtime/rvt'
    if native.is_dir():os.environ['UVYAZKA_RVT_BIN_DIR']=str(native)
    if '--mcp' in sys.argv:
        folder=default_home()/'desktop-sessions';folder.mkdir(parents=True,exist_ok=True)
        lease=folder/('mcp-'+str(os.getpid())+'-'+uuid4().hex+'.json')
        lease.write_text(json.dumps({'pid':os.getpid(),'runtime':str(Path(sys.executable))}))
        atexit.register(lambda:lease.unlink(missing_ok=True))
        from uvyazka.server import main as mcp_main
        try:mcp_main()
        finally:
            # The SDK's UTF-8 transport may close the original wrapper at EOF.
            # PyInstaller explicitly flushes sys.stdout during shutdown, unlike
            # the normal Python executable. Restore an empty stream only AFTER
            # the protocol has finished; no response is swallowed.
            import io
            sys.stdout=sys.__stdout__=io.StringIO()
        return
    parser=argparse.ArgumentParser();parser.add_argument('--serve',action='store_true');parser.add_argument('--home');parser.add_argument('--port',type=int,default=0);parser.add_argument('--demo',action='store_true');parser.add_argument('--self-check',action='store_true');args=parser.parse_args()
    workspace=Workspace(args.home)
    if args.self_check:
        import ifcopenshell,numpy,pymupdf,openpyxl,docx,xlrd,mcp
        from uvyazka.construction.clashes import REVISION
        from uvyazka.construction.model_tables import compute,engine_sha
        compute('describe',{})
        from uvyazka.construction.rvt_runtime import converter_status
        print(json.dumps({'core':'ok','table_engine_sha256':engine_sha(),'clashes':REVISION,'native_rvt':converter_status(workspace.home)},ensure_ascii=False));return
    if args.demo:
        from uvyazka.demo import create_demo
        from uvyazka.construction.demo import create_engineering_demo
        create_demo(workspace);create_engineering_demo(workspace)
    from uvyazka.dashboard import make_handler
    from uvyazka import __version__
    server=ThreadingHTTPServer(('127.0.0.1',args.port),make_handler(workspace));server.desktop_embed=True
    print(json.dumps({'desktop_api':1,'port':server.server_port,'core_version':__version__}),flush=True)
    try:server.serve_forever()
    finally:server.server_close()


if __name__=='__main__':main()
