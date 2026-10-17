"""Download pinned public test models to ignored storage, verifying SHA-256."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parents[1]
if __name__=='__main__':
    destination=ROOT/'.uvyazka-build/browser-fixtures';destination.mkdir(parents=True,exist_ok=True)
    for item in json.loads((ROOT/'tools/browser-fixtures.json').read_text(encoding='utf8')):
        path=destination/item['name']
        if not path.is_file():
            with urlopen(item['url'],timeout=120) as response:data=response.read(item['size']+1)
            if len(data)!=item['size'] or hashlib.sha256(data).hexdigest()!=item['sha256']:
                raise ValueError('Fixture changed: '+item['name'])
            path.write_bytes(data)
        if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:
            raise ValueError('Local fixture changed: '+item['name'])
        print(path.name,flush=True)
