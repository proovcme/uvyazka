"""Run on the VPS: verify a static release, switch its symlink, retain rollback.

Never uploads model files, edits Caddy configuration or touches the main site.
The input archive must contain only the contents of build_demo_site.py output.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
from urllib.request import urlopen


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def switch(link, target):
    temporary = link.with_name(link.name + '.next')
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError('Pending symlink already exists: ' + str(temporary))
    temporary.symlink_to(target)
    os.replace(temporary, link)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--release', required=True, help='Unique release name, e.g. 20261022-0123456789ab')
    parser.add_argument('--root', type=Path, default=Path('/var/www/uvyazka'))
    parser.add_argument('--url', default='https://locia.work/uvyazka/')
    args = parser.parse_args()
    assert len(args.revision) == 40 and all(c in '0123456789abcdef' for c in args.revision)
    assert args.release and all(c in '0123456789abcdefghijklmnopqrstuvwxyz-' for c in args.release)
    assert digest(args.archive) == args.sha256, 'Archive checksum mismatch'
    root = args.root.resolve()
    current = root / 'current'
    assert current.is_symlink(), 'An existing deployment symlink is required'
    previous = current.resolve(strict=True)
    assert previous.is_relative_to(root / 'releases'), 'Unexpected current target'
    release = root / 'releases' / args.release
    assert not release.exists(), 'Never overwrite a published release'
    staging = release.with_name(release.name + '.incoming')
    staging.mkdir(mode=0o755)
    with tarfile.open(args.archive) as source:
        names = set()
        for member in source.getmembers():
            name = PurePosixPath(member.name)
            assert member.name not in names, 'Duplicate archive member'
            names.add(member.name)
            assert name.parts and not name.is_absolute() and '..' not in name.parts
            assert member.isfile() and not member.issym() and not member.islnk(), member.name
            target = staging.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as stream, target.open('xb') as output:
                while chunk := stream.read(1024 * 1024):
                    output.write(chunk)
            target.chmod(0o644)
    manifest = json.loads((staging / 'release.json').read_text())
    assert manifest['revision'] == args.revision
    assert manifest['mode'] == 'browser-compute-and-synthetic-demo'
    assert manifest['server_file_upload'] is False and manifest['browser_file_open'] is True
    expected = manifest['files_sha256']
    assert set(expected) | {'release.json'} == names, 'Unexpected or missing release files'
    for name, expected_hash in expected.items():
        assert digest(staging / name) == expected_hash, name
    os.replace(staging, release)
    switched = False
    try:
        switch(current, release)
        switched = True
        with urlopen(args.url + 'release.json', timeout=30) as response:
            live = json.load(response)
        assert live['revision'] == args.revision, 'Live revision differs'
        for name in ['index.html', 'runtime/rvt/uvyazka_rvt_browser_bg.wasm', 'cad/index.html']:
            with urlopen(args.url + name, timeout=30) as response:
                assert hashlib.sha256(response.read()).hexdigest() == expected[name], name
    except Exception:
        if switched:
            switch(current, previous)
        raise
    result = {'deployed_at': datetime.now(timezone.utc).isoformat(), 'revision': args.revision,
              'version': manifest['version'], 'current': str(release), 'previous': str(previous),
              'verified_files': len(expected), 'url': args.url}
    (root / ('deployment-' + args.release + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
