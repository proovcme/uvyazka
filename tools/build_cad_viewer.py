"""Build the optional self-contained GPL CAD viewer and publish corresponding sources."""
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'integrations/cad-viewer'

def build(destination: Path):
    cache = ROOT / '.uvyazka-build/cad-sources'
    cache.mkdir(parents=True, exist_ok=True)
    public = APP / 'public'
    (public / 'fonts').mkdir(parents=True, exist_ok=True)
    (public / 'sources').mkdir(exist_ok=True)
    entries = json.loads((APP / 'sources.lock.json').read_text())
    links = []
    for item in entries:
        saved = cache / item['name']
        if not saved.is_file():
            with urlopen(item['url'], timeout=120) as response:
                saved.write_bytes(response.read())
        if hashlib.sha256(saved.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Source checksum mismatch: ' + item['name'])
        folder = 'fonts' if item['name'] in ('NotoSans.ttf', 'OFL.txt') else 'sources'
        shutil.copyfile(saved, public / folder / item['name'])
        links.append(f'<li><a href="./{folder}/{html.escape(item["name"])}">{html.escape(item["name"])}</a> · SHA-256 {item["sha256"]}</li>')
    (public / 'fonts/fonts.json').write_text(json.dumps([{'name':['NotoSans'], 'file':'NotoSans.ttf', 'type':'mesh', 'url':'NotoSans.ttf'}]))
    shutil.copyfile(APP / 'LICENSE', public / 'LICENSE')
    with zipfile.ZipFile(public / 'sources/uvyazka-cad-host.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in APP.iterdir():
            if path.is_file(): archive.write(path, 'integrations/cad-viewer/' + path.name)
        archive.write(Path(__file__), 'tools/build_cad_viewer.py')
    (public / 'sources.html').write_text('''<!doctype html><html lang="ru"><meta charset="utf-8"><title>CAD — исходники и лицензии</title>
<style>body{max-width:850px;margin:40px auto;padding:20px;font:16px/1.6 system-ui}li{overflow-wrap:anywhere}</style>
<h1>DWG / DXF в Увязке</h1><p>Самостоятельное приложение на MLightCAD cad-simple-viewer 1.7.6 (MIT),
libredwg-converter 3.15.11 и libredwg-web 0.8.1 (GPL-3.0). Приложение и его сборка распространяются
по <a href="./LICENSE">GNU GPL v3</a>. Python/MCP-пакет Увязки распространяется отдельно; условия его компонентов не изменяются.</p>
<p>Шрифт замены Noto Sans — SIL OFL. Оригинальные SHX и другие шрифты чертежа могут отсутствовать;
начертание и размеры текста требуют проверки. Файл обрабатывается в браузере.</p>
<h2>Соответствующие исходники</h2><ul>''' + ''.join(links) + '''<li><a href="./sources/uvyazka-cad-host.zip">Код приложения, lock-файл и инструкция сборки</a></li></ul>
<p>Репозитории: <a href="https://github.com/mlightcad/cad-viewer">cad-viewer</a>,
<a href="https://github.com/mlightcad/realdwg-web">realdwg-web</a>,
<a href="https://github.com/mlightcad/libredwg-web">libredwg-web</a>.</p></html>''', encoding='utf-8')
    subprocess.run([shutil.which('npm.cmd' if os.name == 'nt' else 'npm'), 'run', 'build'], cwd=APP, check=True)
    shutil.copytree(APP / 'dist', destination, dirs_exist_ok=True)

if __name__ == '__main__':
    build(ROOT / '.uvyazka-build/public-site/uvyazka/cad')
