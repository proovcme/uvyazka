"""Cache the official buildingSMART schemas at reviewed SHA-256 for XML QA."""
from pathlib import Path
from urllib.request import urlopen
import hashlib
import json

ROOT=Path(__file__).resolve().parents[1]

if __name__=='__main__':
    rows=json.loads((ROOT/'tools/bcf-schemas.lock.json').read_text())
    for row in rows:
        target=ROOT/'.uvyazka-build/bcf-schemas'/row['version']/row['name']
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest()==row['sha256']:continue
        with urlopen(row['url'],timeout=30) as response:data=response.read()
        if hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('BCF schema checksum mismatch: '+row['name'])
        target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    print('Official BCF XML schemas verified:',len(rows))
