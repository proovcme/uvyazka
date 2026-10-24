"""Explicit Windows setup: pinned helper + weights (~906 MB), no app installation.
Run with the Python environment containing uvyazka. No project files are sent.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.request import urlopen

RELEASE='https://github.com/ARahim3/DigUp/releases/download/v0.7.0-beta.3/'
MODEL='https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/'
FILES=[
 ('DigUp_0.7.0-beta.3_x64-setup.exe',RELEASE,'013ee9bdc08eb1256cb1b49b0ec11549ae7929f07536e18fbc14fe46d6059fe1'),
 ('embeddinggemma-2-Q8_0.gguf',MODEL,'2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135'),
 ('mmproj-embeddinggemma-2-Q8_0.gguf',MODEL,'c4a8a52691ecef40618438928bdf9e68379b854e24166f292592353db0aab64f')]

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
    return h.hexdigest()

def download(path,url,expected):
    if path.exists():
        if sha(path)==expected:print('Verified existing',path.name,flush=True);return
        raise ValueError('Existing file has a different hash: '+str(path))
    temporary=path.with_suffix(path.suffix+'.download');total=0;last=0
    with urlopen(url,timeout=60) as source,temporary.open('wb') as target:
        while data:=source.read(1024*1024):
            target.write(data);total+=len(data)
            if total-last>=32*1024*1024:print(path.name,total//1024//1024,'MiB',flush=True);last=total
    if sha(temporary)!=expected:raise ValueError('Downloaded hash mismatch: '+path.name)
    temporary.replace(path);print('Verified',path.name,flush=True)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home',required=True);parser.add_argument('--runtime',help='Default: <home>/embedding-runtime')
    parser.add_argument('--seven-zip',default=shutil.which('7z') or 'C:/Program Files/7-Zip/7z.exe')
    args=parser.parse_args()
    if sys.platform!='win32':parser.error('This pinned binary is Windows x64; configure your own compatible worker on other platforms')
    exe=Path(args.seven_zip)
    if not exe.is_file():parser.error('Install 7-Zip or supply --seven-zip; setup only extracts the installer')
    from uvyazka.core import Workspace
    from uvyazka.embedding_worker import configure
    home=Workspace(args.home).home;runtime=Path(args.runtime).resolve() if args.runtime else home/'embedding-runtime'
    runtime.mkdir(parents=True,exist_ok=True);(runtime/'models').mkdir(exist_ok=True)
    for name,base,digest in FILES:
        path=(runtime if name.endswith('.exe') else runtime/'models')/name
        download(path,base+name,digest)
    result=subprocess.run([str(exe),'x','-y','-o'+str(runtime/'extracted'),str(runtime/FILES[0][0]),'helper/*','THIRD-PARTY-NOTICES.txt'],capture_output=True,text=True)
    if result.returncode:raise ValueError('7-Zip extraction failed: '+result.stderr[-1000:])
    if not (runtime/'extracted/THIRD-PARTY-NOTICES.txt').is_file():raise ValueError('Upstream notices missing')
    print(configure(home,runtime/'extracted/helper/digup.exe',runtime/'models'))

if __name__=='__main__':main()
