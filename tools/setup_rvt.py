"""Build the included RVT sources and atomically activate a local runtime."""
from __future__ import annotations
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
from uvyazka.construction.rvt_runtime import NAMES, binary_name, sha256


def canonical_sha(path):
    return hashlib.sha256(Path(path).read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def verify_source():
    upstream = ROOT/'integrations/rvt-rs'
    record = json.loads((upstream/'UVYAZKA-SOURCE.json').read_text(encoding='utf-8'))
    for item in record['files']:
        path = upstream/item['path']
        if not path.resolve().is_relative_to(upstream.resolve()) or canonical_sha(path) != item['sha256']:
            raise ValueError('Vendored source changed; review and update UVYAZKA-SOURCE.json: '+item['path'])
    return record


def build(home, profile='release', with_fixture_generator=False):
    source = verify_source()
    cargo = shutil.which('cargo')
    if not cargo:
        raise ValueError('Rust >=1.87 and native C/C++ build tools are required; cargo is not on PATH')
    target = ROOT/'.uvyazka-build/rvt-target'
    environment = {**os.environ, 'CARGO_TARGET_DIR': str(target)}
    profile_args = ['--release'] if profile == 'release' else []
    names = ['rvt-ifc','rvt-info','rvt-capabilities'] + (['gen-fixture'] if with_fixture_generator else [])
    bins = [argument for name in names for argument in ['--bin', name]]
    subprocess.run([cargo, 'build', '--locked', '--manifest-path', str(ROOT/'integrations/rvt-rs/Cargo.toml'), *profile_args, *bins],env=environment,check=True)
    subprocess.run([cargo, 'build', '--locked', '--manifest-path', str(ROOT/'integrations/rvt-metadata-reader/Cargo.toml'), *profile_args],env=environment,check=True)
    built = target/('release' if profile == 'release' else 'debug')
    hashes = {name: sha256(built/binary_name(name)) for name in NAMES}
    compiler = subprocess.check_output(['rustc','--version'],text=True).strip()
    own = ROOT/'integrations/rvt-metadata-reader'
    metadata_files = [own/'Cargo.toml',own/'Cargo.lock',*sorted((own/'src').rglob('*.rs'))]
    metadata_source = {p.relative_to(own).as_posix():canonical_sha(p) for p in metadata_files}
    identity = {'upstream_revision': source['revision'], 'upstream_manifest_sha256': canonical_sha(ROOT/'integrations/rvt-rs/UVYAZKA-SOURCE.json'),
        'metadata_source':metadata_source,'compiler':compiler,'profile':profile,'platform':sys.platform,'binaries':hashes}
    release = hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    runtime = Path(home).resolve()/'tools/rvt'
    folder = runtime/'releases'/release
    manifest = {'schema_version':1,'release':release,**identity}
    if not folder.exists():
        staging = runtime/'releases'/('staging-'+uuid4().hex)
        staging.mkdir(parents=True)
        for name in NAMES: shutil.copy2(built/binary_name(name), staging/binary_name(name))
        for name in ['LICENSE','NOTICE']: shutil.copyfile(ROOT/'integrations/rvt-rs'/name, staging/name)
        (staging/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
        staging.rename(folder)
    for name in NAMES:
        if sha256(folder/binary_name(name)) != hashes[name]:
            raise ValueError('Existing runtime release has changed; activation stopped')
    temporary = runtime/('active-'+uuid4().hex+'.json')
    temporary.write_text(json.dumps({'schema_version':1,'release':release}),encoding='utf-8')
    os.replace(temporary,runtime/'active.json')
    print(json.dumps({'available':True,'release':release,'bin_dir':str(folder),'upstream_revision':source['revision'],'profile':profile},ensure_ascii=False))
    return folder


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home',type=Path,default=default_home(),help='Same state directory as UVYAZKA_HOME')
    parser.add_argument('--profile',choices=['release','dev'],default='release')
    parser.add_argument('--with-fixture-generator',action='store_true',help='Also build the upstream synthetic test generator')
    parser.add_argument('--verify-source-only',action='store_true')
    args = parser.parse_args()
    try:
        if args.verify_source_only: print('Verified',len(verify_source()['files']),'vendored source files')
        else: build(args.home,args.profile,args.with_fixture_generator)
    except (OSError,ValueError,subprocess.CalledProcessError) as error:
        parser.exit(1,'RVT setup failed: '+str(error)+'\n')
