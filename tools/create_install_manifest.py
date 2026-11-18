"""Stage a version-pinned first-install contract; never publish or install it."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
MAX_INSTALLER = 1536 * 1024 * 1024


def stage(installer: Path, output: Path, config: dict, bootstrap: Path) -> dict:
    version = config['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
        raise ValueError('Invalid release version')
    if config['bundle']['windows']['nsis']['installMode'] != 'currentUser':
        raise ValueError('First-install contract requires currentUser NSIS')
    size = installer.stat().st_size
    with installer.open('rb') as source:
        if installer.suffix.lower() != '.exe' or source.read(2) != b'MZ' or not 100000 <= size <= MAX_INSTALLER:
            raise ValueError('Built bounded Windows installer required')
    signature = Path(str(installer) + '.sig').read_text(encoding='utf-8').strip()
    if not base64.b64decode(signature, validate=True).startswith(b'untrusted comment:'):
        raise ValueError('Tauri updater signature required')
    name = f'uvyazka_{version}_x64-setup.exe'
    base = f'https://github.com/proovcme/uvyazka/releases/download/v{version}/'
    digest = hashlib.sha256()
    with installer.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    script_hash = hashlib.sha256(bootstrap.read_bytes()).hexdigest()
    value = {
        'schema': 'uvyazka.install.v1', 'version': version, 'release_tag': 'v' + version,
        'platform': 'windows-x86_64', 'operation': 'first_install',
        'installer': {'kind': 'nsis', 'scope': 'currentUser', 'url': base + name,
                      'size': size, 'sha256': digest.hexdigest(), 'arguments': ['/S'],
                      'updater_signature': signature},
        'bootstrap': {'url': base + 'install-windows.ps1', 'sha256': script_hash},
        'existing_installation': 'use_in_app_signed_updater',
        'readiness': 'discover_and_check_local_api_after_installer_exit',
    }
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(installer, output / name)
    (output / (name + '.sig')).write_text(signature + '\n', encoding='utf-8')
    shutil.copyfile(bootstrap, output / 'install-windows.ps1')
    (output / 'uvyazka-install.json').write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('installer', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((ROOT / 'desktop/src-tauri/tauri.conf.json').read_text(encoding='utf-8-sig'))
    value = stage(args.installer, args.output, config, ROOT / 'tools/install-windows.ps1')
    print(json.dumps({'schema': value['schema'], 'version': value['version'], 'output': str(args.output)}))
