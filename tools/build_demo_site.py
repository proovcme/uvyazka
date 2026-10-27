"""Build the public read-only demo using generated data, never local projects."""
import os
import argparse
import hashlib
import gzip
import html
import json
from pathlib import Path
import shutil
import subprocess
import tomllib
from build_public_demo import export
from build_demo_catalog import export as export_catalog
from build_cad_viewer import build as build_cad_viewer
from build_review_demo import export as export_review

ROOT = Path(__file__).resolve().parents[1]
PORTABLE_CSP="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'"

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
    export_review(output / 'demo')
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
<h2>NWD и таблицы</h2><p>Экспериментальный независимый NWD-читатель читает поддержанное подмножество геометрии, исходного дерева и типизированных свойств. Единицы берутся из прочитанного заголовка; для неизвестного заголовка выбор сохраняется как допущение пользователя. Геометрические фрагменты не считаются оборудованием. Сохранённые виды, наборы выбора, исходные коллизии и TimeLiner пока не импортируются. Конструктор таблиц работает с прочитанными полями RVT/IFC/NWD: фильтры, группировка, итоги и источники ячеек, CSV/JSON. Произвольная таблица не воспроизводит формулы Revit.</p>
<p>Скрытые элементы доступны через «Скрыто: N → Список» после снятия выделения. Галочка возвращает один элемент; «Вернуть все» восстанавливает все скрытые, сохраняя поиск и камеру.</p>
<h2>Спецификация оборудования</h2><p>Готовая форма 1 по ГОСТ 21.110-2013: настройка источников
через заголовки граф, предпросмотр А3 с основными надписями 3/6, PDF, XLSX и JSON с источниками.
Первая версия считает физические экземпляры в штуках; незаданные и неподтверждённые значения
сохраняют статус черновика. Подписи и даты автоматически не проставляются.</p>
<p>Собственный код — Apache-2.0; сторонние компоненты сохраняют свои условия. <a href="../UVYAZKA-LICENSE.txt">Лицензия</a> · <a href="../UVYAZKA-NOTICE.txt">Уведомления</a>.</p>
<h2>Установка</h2><p>Исходный архив содержит Python-инструменты и исходники Rust-декодера.
Для сборки RVT нужны Rust и инструменты C/C++; готовые нативные программы в эти архивы
не включены. Wheel содержит Python-пакет, а сборка RVT требует исходного архива.</p>
<p><a href="https://github.com/proovcme/uvyazka/releases/tag/v0.4.0-alpha.1">Настольная Увязка для Windows x64: установщик и соответствующие исходники</a>.</p>
<ul>{''.join(links)}<li><a href="https://github.com/proovcme/uvyazka/blob/{revision}/README.md">Инструкция по установке</a></li>
<li><a href="https://github.com/proovcme/uvyazka/blob/{revision}/docs/RVT_DATA.md">Возможности и ограничения RVT</a></li></ul>
<p>Версия исходников: <code>{revision}</code>.</p></html>''', encoding='utf-8')
    # Pages has no custom HTTP security headers. Keep the executable-content policy
    # in each HTML document as well; frame-ancestors still requires the VPS header.
    for document in output.rglob('*.html'):
        markup=document.read_text(encoding='utf-8')
        marker='<meta http-equiv="Content-Security-Policy" content="'+html.escape(PORTABLE_CSP,quote=True)+'">'
        if '<head>' in markup:markup=markup.replace('<head>','<head>'+marker,1)
        elif '<meta charset="utf-8">' in markup:markup=markup.replace('<meta charset="utf-8">','<meta charset="utf-8">'+marker,1)
        else:raise ValueError('No policy insertion point in '+str(document))
        document.write_text(markup,encoding='utf-8')
    # Caddy file_server precompressed gzip avoids recompressing large immutable assets
    # and streams a known Content-Length. Originals remain available unchanged.
    for asset in list(output.rglob('*')):
        if asset.is_file() and asset.suffix in {'.json','.js','.css','.wasm','.bin'} and asset.stat().st_size>=1024:
            raw=asset.read_bytes();packed=gzip.compress(raw,compresslevel=6,mtime=0)
            if len(packed)<len(raw)*.9:asset.with_name(asset.name+'.gz').write_bytes(packed)
    files = {p.relative_to(output).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(output.rglob('*')) if p.is_file()}
    (output / 'release.json').write_text(json.dumps({'version': version, 'revision': revision,
        'mode': 'browser-compute-and-public-examples', 'server_file_upload': False, 'browser_file_open': True, 'files_sha256': files}, indent=2) + '\n', encoding='utf-8')
    print('Public static demo:', output)
