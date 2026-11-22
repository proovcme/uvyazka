"""Report or remove Uvyazka's reproducible build directories in this checkout."""

import argparse
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
CACHES = (
    '.uvyazka-build/desktop/dist',
    '.uvyazka-build/desktop/licenses',
    '.uvyazka-build/desktop/source',
    '.uvyazka-build/desktop/work',
    '.uvyazka-build/nwd-recovery-target',
    '.uvyazka-build/rvt-browser-host-target',
    '.uvyazka-build/rvt-browser-target',
    '.uvyazka-build/rvt-target',
    'desktop/src-tauri/binaries',
    'desktop/src-tauri/target',
    'integrations/nwd-browser-bridge/target',
    'integrations/rvt-browser-bridge/target',
    'integrations/rvt-metadata-reader/target',
    'integrations/rvt-rs/target',
)


def targets():
    for relative in CACHES:
        path = ROOT / relative
        if not path.exists():
            continue
        if not path.is_dir() or path.resolve() != path:
            raise ValueError(f'Unexpected cache path: {relative}')
        size = 0
        for entry in path.rglob('*'):
            if entry.is_symlink() or entry.name == '.git' or entry.resolve() != entry:
                raise ValueError(f'Unexpected linked or Git entry in {relative}')
            if entry.is_file():
                size += entry.stat().st_size
        yield path, size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Remove listed caches after stopping local builds and dev servers')
    args = parser.parse_args()
    entries = list(targets())
    for path, size in entries:
        if args.apply:
            shutil.rmtree(path)
        print(json.dumps({'path': path.relative_to(ROOT).as_posix(), 'bytes': size, 'removed': args.apply}))
    print(json.dumps({'total_bytes': sum(size for _, size in entries), 'removed': args.apply}))


if __name__ == '__main__':
    main()
