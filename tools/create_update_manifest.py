"""Write a beta channel only after the installer and its signature exist."""
import argparse
import base64
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('installer',type=Path)
    parser.add_argument('--output',type=Path,default=ROOT/'web/public/updates/beta.json')
    args=parser.parse_args();installer=args.installer.resolve(strict=True)
    if installer.suffix.lower()!='.exe' or installer.stat().st_size<100000:raise ValueError('Built NSIS installer required')
    signature=Path(str(installer)+'.sig').read_text(encoding='utf-8').strip()
    decoded=base64.b64decode(signature,validate=True)
    if not decoded.startswith(b'untrusted comment:'):raise ValueError('Tauri signature file required')
    version=json.loads((ROOT/'desktop/src-tauri/tauri.conf.json').read_text(encoding='utf-8-sig'))['version']
    name=f'uvyazka_{version}_x64-setup.exe'
    value={'version':version,'notes':'Проверки геометрии, виды и шаблоны, BCF/XLSX и полный локальный комплекс Увязки. Предварительный выпуск.','pub_date':datetime.now(timezone.utc).isoformat(),
           'platforms':{'windows-x86_64':{'signature':signature,'url':f'https://github.com/proovcme/uvyazka/releases/download/v{version}/{name}'}}}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'channel':str(args.output),'installer_name':name,'installer_sha256':hashlib.sha256(installer.read_bytes()).hexdigest(),'version':version}))
