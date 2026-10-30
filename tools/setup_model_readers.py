"""Build/install the independent Navis metadata reader from the included Rust sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src'))
from uvyazka.core import default_home


def install(home):
    cargo = shutil.which('cargo')
    if not cargo:
        raise ValueError('Install Rust and native C/C++ build tools; cargo is not on PATH')
    source = ROOT/'integrations/nwd-browser-bridge'
    target = ROOT/'.uvyazka-build/nwd-recovery-target'
    subprocess.run([cargo, 'build', '--locked', '--release', '--manifest-path', str(source/'Cargo.toml'), '--bin', 'uvyazka-nwd-experiment'],
        env={**os.environ, 'CARGO_TARGET_DIR': str(target)}, check=True)
    name = 'uvyazka-nwd-experiment' + ('.exe' if os.name == 'nt' else '')
    binary = target/'release'/name
    sha = hashlib.sha256(binary.read_bytes()).hexdigest()
    destination = Path(home).resolve()/'tools/model-readers/nwd'
    destination.mkdir(parents=True, exist_ok=True)
    staging = destination/(name+'.incoming-'+uuid4().hex)
    try:
        shutil.copy2(binary, staging)
        os.replace(staging, destination/name)
    finally:
        staging.unlink(missing_ok=True)
    files = [source/'Cargo.toml', source/'Cargo.lock', *sorted((source/'src').rglob('*.rs'))]
    manifest = {'schema_version': 1, 'binary_sha256': sha, 'source': {
        p.relative_to(source).as_posix(): hashlib.sha256(p.read_bytes().replace(b'\r\n', b'\n')).hexdigest() for p in files}}
    (destination/'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return {'installed': str(destination/name), 'sha256': sha, 'scope': 'metadata-only; partial native coverage'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nwd', action='store_true', required=True)
    parser.add_argument('--home', type=Path, default=default_home())
    arguments = parser.parse_args()
    print(json.dumps(install(arguments.home), indent=2))
