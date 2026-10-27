"""Fetch immutable corresponding source archives, verify before packaging."""
from pathlib import Path
from urllib.request import urlopen
import hashlib
import json
import os

ROOT=Path(__file__).resolve().parents[1]


def fetch():
    root=ROOT/'.uvyazka-build/desktop-sources';root.mkdir(parents=True,exist_ok=True)
    rows=json.loads((ROOT/'desktop/sources.lock.json').read_text())
    for row in rows:
        if Path(row['name']).name!=row['name'] or not row['url'].startswith('https://'):raise ValueError('Invalid source record')
        target=root/row['name']
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest()==row['sha256']:continue
        temporary=target.with_suffix(target.suffix+'.part')
        with urlopen(row['url'],timeout=180) as response,temporary.open('wb') as output:
            while data:=response.read(1024*1024):output.write(data)
        if temporary.stat().st_size!=row['size'] or hashlib.sha256(temporary.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('Source checksum mismatch: '+row['name'])
        os.replace(temporary,target)
    print('Corresponding sources verified:',len(rows))


if __name__=='__main__':fetch()
