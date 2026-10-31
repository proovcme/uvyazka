"""Check tracked files and distribution members without printing their contents.

This guards publication boundaries, not engineering confidentiality or every
possible credential format. Run Gitleaks separately and review images manually.
"""
from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_SUFFIXES = {
    '.env', '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore',
    '.db', '.sqlite', '.sqlite3', '.duckdb', '.mdb', '.accdb', '.log',
    '.pdf', '.dwg', '.dxf', '.rvt', '.rfa', '.rte', '.rft', '.rnp',
    '.doc', '.docx', '.xls', '.xlsx', '.xlsm', '.zip', '.rar', '.7z',
    '.nwc', '.nwd', '.bcf', '.bcfzip', '.bak', '.gguf', '.safetensors',
}
PRIVATE_NAMES = {
    '.npmrc', '.pypirc', '.netrc', 'projects.local.json', 'settings.local.json',
}
PRIVATE_PARTS = {'.ssh', '.aws', '.azure', 'secrets', 'node_modules', '__pycache__', '.venv'}
ALLOWED_DATA = {'tests/fixtures/structure-synthetic.xls'}
EXAMPLE_USERS = {'alice', 'bob', 'testuser', 'user', 'username', 'example', 'runner', 'pyodide', '...'}
HOME_PATH = re.compile(r'''(?i)(?:[a-z]:[\\/]+Users[\\/]+|/Users[/]|/home[/])([^\\/\s"'`<>]+)''')
SDIST_METADATA = {
    'PKG-INFO', 'setup.cfg',
    *('src/uvyazka.egg-info/' + name for name in (
        'PKG-INFO', 'SOURCES.txt', 'dependency_links.txt', 'entry_points.txt',
        'requires.txt', 'top_level.txt',
    )),
}
WHEEL_METADATA = {'METADATA', 'WHEEL', 'RECORD', 'entry_points.txt', 'top_level.txt'}


def file_issues(name: str, data: bytes) -> list[str]:
    path = PurePosixPath(name)
    reasons = []
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        reasons.append('unsafe member path')
    if name not in ALLOWED_DATA and (
        path.suffix.lower() in PRIVATE_SUFFIXES
        or path.name in PRIVATE_NAMES
        or (path.name.startswith('.env') and path.name != '.env.example')
        or path.name.startswith(('credentials', 'service-account'))
        or PRIVATE_PARTS.intersection(path.parts)
        or any(part.startswith('.uvyazka') for part in path.parts)
        or (path.parts and path.parts[0] in {'data', 'projects', 'artifacts', 'backups', 'logs', 'cache', 'models'})
        or name in {'.codex/config.toml', '.claude/settings.local.json', '.gemini/settings.json'}
    ):
        reasons.append('private/local data or model asset')
    if b'\0' not in data[:8192]:
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError:
            content = ''
        for match in HOME_PATH.finditer(content):
            if match[1].lower() not in EXAMPLE_USERS:
                line = content.count('\n', 0, match.start()) + 1
                reasons.append(f'non-example user home path at line {line}')
    return reasons


def tracked_files(root: Path) -> set[str]:
    raw = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'])
    return set(raw.decode('utf-8').rstrip('\0').split('\0')) - {''}


def check_tree(root: Path, tracked: set[str]) -> list[str]:
    issues = []
    for name in sorted(tracked):
        path = root / name
        if path.is_symlink():
            issues.append(f'{name}: tracked symlink requires publication review')
        elif not path.is_file():
            issues.append(f'{name}: tracked file missing')
        else:
            issues.extend(f'{name}: {reason}' for reason in file_issues(name, path.read_bytes()))
    return issues


def check_archive(archive: Path, tracked: set[str]) -> list[str]:
    issues = []
    def check(name, data, wheel=False):
        original = PurePosixPath(name)
        if original.is_absolute() or '..' in original.parts or '\\' in name:
            issues.append(f'{archive.name}!{name}: unsafe member path')
        canonical = name
        generated = False
        if wheel:
            parts = PurePosixPath(name).parts
            if len(parts) == 2 and parts[0].startswith('uvyazka-') and parts[0].endswith('.dist-info'):
                generated = parts[1] in WHEEL_METADATA
            elif len(parts) >= 3 and parts[0].startswith('uvyazka-') and parts[0].endswith('.dist-info') and parts[1] == 'licenses':
                canonical = '/'.join(parts[2:])
            elif name.startswith('uvyazka/'):
                canonical = 'src/' + name
            elif '/data/share/uvyazka/' in name:
                canonical = name.split('/data/share/uvyazka/', 1)[1]
        else:
            canonical = name.split('/', 1)[1] if '/' in name else ''
            generated = canonical in SDIST_METADATA
        if not generated and canonical not in tracked:
            issues.append(f'{archive.name}!{name}: file is not in tracked publication inputs')
        issues.extend(f'{archive.name}!{name}: {reason}' for reason in file_issues(canonical, data))
    if archive.suffix == '.whl':
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                if not member.is_dir():
                    check(member.filename, source.read(member), wheel=True)
    else:
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                if member.isfile():
                    check(member.name, source.extractfile(member).read())
                elif not member.isdir():
                    issues.append(f'{archive.name}!{member.name}: non-regular archive member')
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', action='append', type=Path, default=[])
    parser.add_argument('--dist', action='store_true', help='Check the current wheel and sdist from pyproject.toml')
    args = parser.parse_args()
    if args.dist:
        import tomllib
        version = tomllib.loads((ROOT/'pyproject.toml').read_text(encoding='utf-8'))['project']['version']
        args.archive.extend([ROOT/'dist'/f'uvyazka-{version}.tar.gz', ROOT/'dist'/f'uvyazka-{version}-py3-none-any.whl'])
    tracked = tracked_files(ROOT)
    issues = check_tree(ROOT, tracked)
    for archive in args.archive:
        issues.extend(check_archive(archive, tracked))
    for issue in issues:
        print(issue)
    if issues:
        raise SystemExit(1)
    print(f'Public content boundaries OK: {len(tracked)} tracked files, {len(args.archive)} archives')


if __name__ == '__main__':
    main()
