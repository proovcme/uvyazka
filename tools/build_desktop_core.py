"""Freeze only the Git index snapshot; never collect local project material.

Run after building the local viewer, CAD app and browser runtimes, and staging
the intended source changes. Output is ignored. No secret is required here.
"""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import sys
import hashlib
import tarfile
import zipfile
from importlib import metadata

ROOT=Path(__file__).resolve().parents[1]


def build():
    output=ROOT/'.uvyazka-build/desktop'
    output.mkdir(parents=True,exist_ok=True)
    source=output/'source'
    if source.exists():
        if not source.resolve().is_relative_to(output.resolve()):raise ValueError('Unexpected snapshot path')
        shutil.rmtree(source)
    source.mkdir()
    subprocess.run(['git','checkout-index','--all','--prefix='+source.as_posix()+'/'],cwd=ROOT,check=True)
    subprocess.run([sys.executable,str(ROOT/'tools/check_public_content.py')],cwd=ROOT,check=True)
    native=ROOT/'.uvyazka-build/rvt-target/release'
    runtime=ROOT/'.uvyazka-build/browser-runtime'
    cad=ROOT/'integrations/cad-viewer/dist'
    for path in (native/'rvt-ifc.exe',native/'rvt-info.exe',native/'rvt-capabilities.exe',native/'ifccs-rvt-metadata.exe',runtime/'planner.zip',cad/'index.html'):
        if not path.is_file():raise ValueError('Build the required runtime first: '+str(path))
    # PyInstaller follows explicit snapshot paths, including hidden core modules.
    hidden=['uvyazka.'+p.relative_to(source/'src/uvyazka').with_suffix('').as_posix().replace('/','.') for p in (source/'src/uvyazka').rglob('*.py') if p.name!='__init__.py']
    datas=[]
    for path in (source/'src/uvyazka').rglob('*'):
        if path.is_file() and path.suffix!='.py':datas.append((str(path),str(Path('uvyazka')/path.parent.relative_to(source/'src/uvyazka'))))
    datas += [(str(cad),'uvyazka/viewer/cad'),(str(runtime),'uvyazka/viewer/runtime'),(str(source/'skills'),'share/uvyazka/skills')]
    for name in ('LICENSE','NOTICE'):datas.append((str(source/name),'uvyazka-runtime/licenses'))
    licenses=output/'licenses';licenses.mkdir(exist_ok=True)
    for dist in metadata.distributions():
        name=dist.metadata['Name']
        if name.lower()=='uvyazka':continue
        for f in dist.files or []:
            if any(word in Path(str(f)).name.lower() for word in ('license','copying','copyright','notice')):
                path=Path(dist.locate_file(f))
                if path.is_file() and path.stat().st_size<1024*1024:
                    target=licenses/name/str(f).replace('..','_');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
    archives=ROOT/'.uvyazka-build/desktop-sources'
    catalog=json.loads((source/'desktop/sources.lock.json').read_text())
    for row in catalog:
        path=archives/row['name']
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('Fetch and verify corresponding source: '+row['name'])
        with tarfile.open(path) as archive:
            for item in archive:
                if item.isfile() and any(x in Path(item.name).name.upper() for x in ('LICENSE','COPYING','EXCEPTION')) and item.size<1000000:
                    target=licenses/row['name']/Path(item.name).name
                    if not target.exists():target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(item).read())
    shutil.copyfile(source/'desktop/THIRD_PARTY.md',licenses/'DESKTOP-NOTICE.md')
    if (source/'desktop/licenses').is_dir():shutil.copytree(source/'desktop/licenses',licenses/'additional',dirs_exist_ok=True)
    shutil.copyfile(source/'desktop/sources.lock.json',licenses/'sources.lock.json')
    python_license=Path(sys.base_prefix)/'LICENSE.txt'
    if python_license.is_file():shutil.copyfile(python_license,licenses/'PYTHON-LICENSE.txt')
    own_source=output/'uvyazka-source.zip'
    with zipfile.ZipFile(own_source,'w',zipfile.ZIP_DEFLATED) as archive:
        for path in source.rglob('*'):
            if path.is_file():archive.write(path,path.relative_to(source).as_posix())
    datas += [(str(licenses),'uvyazka-runtime/licenses'),(str(own_source),'uvyazka-runtime/sources')]
    binaries=[(str(native/name),'uvyazka-runtime/rvt') for name in ('rvt-ifc.exe','rvt-info.exe','rvt-capabilities.exe','ifccs-rvt-metadata.exe')]
    spec=output/'uvyazka-core.spec'
    spec.write_text('''from pathlib import Path
from PyInstaller.utils.hooks import collect_all, copy_metadata
datas = '''+repr(datas)+'''
binaries = '''+repr(binaries)+'''
hiddenimports = '''+repr(hidden)+'''
for package in ('mcp','pymupdf','ifcopenshell','openpyxl','docx','xlrd','ezdxf','py_mini_racer'):
    d,b,h = collect_all(package,filter_submodules=lambda name: not any(x in name.split('.') for x in ('cli','tests','test','draw','bonsai')))
    b=[entry for entry in b if not any(x in Path(entry[0]).name.lower() for x in ('kernel_cgal','kernel_manifold','manifold.dll'))]
    datas += d; binaries += b; hiddenimports += h
for package in ('mcp','pymupdf','ifcopenshell','numpy','openpyxl','python-docx','xlrd','ezdxf','pydantic','pillow','mini-racer'):
    datas += copy_metadata(package)
a = Analysis(['''+repr(str(source/'desktop/sidecar.py'))+'''], pathex=['''+repr(str(source/'src'))+'''], binaries=binaries, datas=datas, hiddenimports=hiddenimports, excludes=['tkinter','PySide6','PyQt5','PyQt6','matplotlib','scipy','pandas','IPython','pytest','uvyazka._vendor.les_list.tests'])
a.binaries=[entry for entry in a.binaries if not any(x in Path(entry[0]).name.lower() for x in ('kernel_cgal','kernel_manifold','manifold.dll'))]
pyz = PYZ(a.pure)
exe = EXE(pyz,a.scripts,[],exclude_binaries=True,name='uvyazka-core',console=True)
coll = COLLECT(exe,a.binaries,a.datas,strip=False,upx=False,name='uvyazka-core')
''',encoding='utf-8')
    subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--distpath',str(output/'dist'),'--workpath',str(output/'work'),str(spec)],cwd=ROOT,check=True)
    frozen=output/'dist/uvyazka-core'
    target=ROOT/'desktop/src-tauri/binaries';target.mkdir(exist_ok=True)
    internal=target/'_internal'
    if internal.exists():
        if not internal.resolve().is_relative_to(target.resolve()):raise ValueError('Unexpected binary path')
        shutil.rmtree(internal)
    shutil.copytree(frozen/'_internal',internal)
    shutil.copyfile(frozen/'uvyazka-core.exe',target/'uvyazka-core-x86_64-pc-windows-msvc.exe')
    print(json.dumps({'desktop_core':str(frozen),'source_snapshot':'git index','native_rvt':True}))


if __name__=='__main__':build()
