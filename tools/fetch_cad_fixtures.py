"""Extract four public upstream DWG regression fixtures from the verified source archive.

Run tools/build_cad_viewer.py first. Models remain in ignored build storage.
"""
from pathlib import Path
import hashlib
import json
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def main():
    entries = json.loads((ROOT / 'integrations/cad-viewer/sources.lock.json').read_text(encoding='utf-8'))
    item = next(x for x in entries if x['name'] == 'libredwg-web-source.tar.gz')
    archive = ROOT / '.uvyazka-build/cad-sources' / item['name']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == item['sha256']
    destination = ROOT / '.uvyazka-build/browser-fixtures'
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        for suffix, name in [('2000/PolyLine2D.dwg','PolyLine2D.dwg'), ('2018/Line.dwg','2018-Line.dwg'),
                             ('2000/Line.dwg','2000-Line.dwg'), ('2000/Text.dwg','2000-Text.dwg')]:
            matches = [m for m in source.getmembers() if m.name.endswith('/test/test-data/' + suffix)]
            assert len(matches) == 1 and matches[0].isfile()
            stream = source.extractfile(matches[0])
            assert stream is not None
            (destination / name).write_bytes(stream.read())
            print(name)

if __name__ == '__main__':
    main()
