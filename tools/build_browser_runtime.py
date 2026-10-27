"""Build browser runtimes locally; publish only fixed assets, never model files."""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import zipfile
import ifcopenshell
from setup_rvt import verify_source

ROOT = Path(__file__).resolve().parents[1]
MODULES = ['__init__', 'simulation', 'critical_path', 'planner', 'production',
           'packages', 'mep', 'access', 'quantities', 'phases', 'clashes', 'clash_geometry', 'clash_export', 'geometry']

def build(skip_rust=False):
    verify_source()
    target = ROOT / '.uvyazka-build/browser-runtime'
    target.mkdir(parents=True, exist_ok=True)
    crate = ROOT / 'integrations/rvt-browser-bridge'
    if not skip_rust:
        subprocess.run(['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', str(crate/'Cargo.toml')], check=True)
    subprocess.run(['wasm-bindgen', str(crate/'target/wasm32-unknown-unknown/release/uvyazka_rvt_browser.wasm'), '--target', 'web', '--out-dir', str(target/'rvt')], check=True)
    nwd = ROOT / 'integrations/nwd-browser-bridge'
    if not skip_rust:
        subprocess.run(['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', str(nwd/'Cargo.toml')], check=True)
    subprocess.run(['wasm-bindgen', str(nwd/'target/wasm32-unknown-unknown/release/uvyazka_nwd_experiment.wasm'), '--target', 'web', '--out-dir', str(target/'nwd')], check=True)
    for name in ['NOTICE.txt', 'THIRD_PARTY_LICENSES.txt']:
        shutil.copyfile(nwd/name, target/'nwd'/name)
    for package, files in {
        'web-ifc': ['web-ifc-api.js', 'web-ifc.wasm', 'LICENSE.md'],
        'pyodide': ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'pyodide-lock.json', 'python_stdlib.zip'],
    }.items():
        folder = target / package
        folder.mkdir(exist_ok=True)
        for name in files:
            shutil.copyfile(ROOT/'web/node_modules'/package/name, folder/name)
    with zipfile.ZipFile(target/'planner.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(ROOT/'src/uvyazka/__init__.py', 'uvyazka/__init__.py')
        for name in MODULES:
            archive.write(ROOT/f'src/uvyazka/construction/{name}.py', f'uvyazka/construction/{name}.py')
    hierarchy = {}
    for schema_name in ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']:
        entries = {}
        for declaration in ifcopenshell.schema_by_name(schema_name).declarations():
            if not hasattr(declaration, 'supertype'):
                continue
            chain, current = [], declaration
            while current:
                chain.append(current.name()); current = current.supertype()
            entries[declaration.name().upper()] = chain
        hierarchy[schema_name] = entries
    (target/'ifc-hierarchy.json').write_text(json.dumps(hierarchy, separators=(',', ':')), encoding='utf-8')
    for name in ['LICENSE', 'NOTICE']:
        shutil.copyfile(ROOT/'integrations/rvt-rs'/name, target/'rvt'/name)
    for source in (ROOT/'integrations/browser-runtime').glob('*.txt'):
        shutil.copyfile(source,target/source.name)
    print(target)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-rust', action='store_true')
    build(parser.parse_args().skip_rust)
