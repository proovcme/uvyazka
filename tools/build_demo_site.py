"""Build the public read-only demo using generated data, never local projects."""
import os
import argparse
import hashlib
import html
import json
from pathlib import Path
import shutil
import subprocess
import tomllib
from build_public_demo import export
from build_demo_catalog import export as export_catalog
from build_cad_viewer import build as build_cad_viewer

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--with-downloads', action='store_true', help='Include the current wheel and source distribution from dist/')
    args = parser.parse_args()
    version = tomllib.loads((ROOT / 'pyproject.toml').read_text(encoding='utf-8'))['project']['version']
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    artifacts = [ROOT / 'dist' / name for name in [f'uvyazka-{version}.tar.gz', f'uvyazka-{version}-py3-none-any.whl']] if args.with_downloads else []
    if any(not artifact.is_file() for artifact in artifacts):
        raise SystemExit('Build the current distribution first: uv build')
    output = ROOT / '.uvyazka-build/public-site/uvyazka'
    runtime = ROOT / '.uvyazka-build/browser-runtime'
    if not (runtime/'planner.zip').is_file():
        raise SystemExit('Build browser assets first: uv run python tools/build_browser_runtime.py')
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not npm:
        raise SystemExit('Install Node.js and run npm ci in web first')
    subprocess.run([npm, 'run', 'build', '--', '--base=/uvyazka/', '--outDir', str(output)],
        cwd=ROOT / 'web', env={**os.environ, 'VITE_UVYAZKA_DEMO': '1'}, check=True)
    build_cad_viewer(output / 'cad')
    export(output / 'demo', ROOT / '.uvyazka-build/synthetic-cache')
    export_catalog(output / 'demo')
    shutil.copytree(runtime, output/'runtime')
    downloads = output / 'downloads'
    downloads.mkdir()
    links = []
    checksums = []
    for artifact in artifacts:
        shutil.copyfile(artifact, downloads / artifact.name)
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        checksums.append(f'{digest}  {artifact.name}')
        links.append(f'<li><a href="{html.escape(artifact.name)}" download>{html.escape(artifact.name)}</a></li>')
    if checksums:
        (downloads / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', encoding='utf-8')
        links.append('<li><a href="SHA256SUMS.txt">Контрольные суммы SHA-256</a></li>')
    (downloads / 'index.html').write_text(f'''<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Увязка {html.escape(version)} — локальные инструменты</title>
<style>body{{max-width:760px;margin:48px auto;padding:0 24px;font:17px/1.65 system-ui;color:#19323d;background:#f4f6f8}}a{{color:#23767b}}li{{margin:12px 0;overflow-wrap:anywhere}}code{{overflow-wrap:anywhere}}h1{{line-height:1.2}}</style>
<a href="../">← Вьювер и симуляция</a><h1>Увязка {html.escape(version)}</h1>
<p>Локальные инструменты для Codex, Claude и других клиентов MCP.</p>
<h2>RVT без Revit</h2><p>Чтение сохранённых данных, видов и определений спецификаций,
конверсия в IFC. Улучшенный декодер читает кириллицу и явные связи инженерных систем
с элементами и базовым оборудованием. Покрытие частичное; результат не подтверждает
полноту подключений или правильность инженерных расчётов.</p>
<p>На сайте можно открыть свой IFC или RVT, посмотреть модель и рассчитать предварительный
сценарий. Конверсия и расчёт выполняются в браузере: файл не отправляется на VPS.
Прежние пороги размера RVT/IFC сняты; большие модели зависят от памяти браузера.
Технический предел RVT-читателя — 2 GiB. Есть журнал этапов и ошибок с выгрузкой.
Стадии RVT пока не читаются в браузере.</p>
<h2>Установка</h2><p>Исходный архив содержит Python-инструменты и исходники Rust-декодера.
Для сборки RVT нужны Rust и инструменты C/C++; готовые нативные программы в эти архивы
не включены. Wheel содержит Python-пакет, а сборка RVT требует исходного архива.</p>
<ul>{''.join(links)}<li><a href="https://github.com/proovcme/uvyazka/blob/{revision}/README.md">Инструкция по установке</a></li>
<li><a href="https://github.com/proovcme/uvyazka/blob/{revision}/docs/RVT_DATA.md">Возможности и ограничения RVT</a></li></ul>
<p>Версия исходников: <code>{revision}</code>.</p></html>''', encoding='utf-8')
    files = {p.relative_to(output).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(output.rglob('*')) if p.is_file()}
    (output / 'release.json').write_text(json.dumps({'version': version, 'revision': revision,
        'mode': 'browser-compute-and-public-examples', 'server_file_upload': False, 'browser_file_open': True, 'files_sha256': files}, indent=2) + '\n', encoding='utf-8')
    print('Public static demo:', output)
