"""Local static preview with the same CSP as the public browser demo."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse

CSP="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'"
ROOT=Path(__file__).resolve().parents[1]/'.uvyazka-build/public-site'

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def end_headers(self):
        cad = self.path.split('?',1)[0].startswith('/uvyazka/cad/')
        self.send_header('Content-Security-Policy',CSP if cad else CSP.replace("frame-ancestors 'self'", "frame-ancestors 'none'"))
        self.send_header('X-Frame-Options','SAMEORIGIN' if cad else 'DENY')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Cache-Control','no-store')
        super().end_headers()
    def log_message(self,*args):pass

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,default=8779)
    args=parser.parse_args();print(f'http://127.0.0.1:{args.port}/uvyazka/',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
