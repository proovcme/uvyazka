"""Portable statement of selected work, never a project-wide audit or approval."""
import csv
import html
import io
import json
import re
from urllib.parse import urlencode, urlsplit

from .core import connection, now
from .document_tables import bounded, number
from .review_work import ReviewWork, identifier


LABELS = {'match': 'Совпало', 'discrepancy': 'Расхождение', 'question': 'Вопрос',
          'unchecked': 'Не проверено', 'pending': 'Ожидает', 'working': 'В работе',
          'blocked': 'Нужны данные', 'reviewed': 'Разобрано', 'needs_recheck': 'Перепроверить',
          'total': 'Всего выбрано'}
WARNING = ('Только выбранный состав проверки. Результаты — интерпретация автора, '
           'не утверждённое инженерное решение. Полнота проекта не подтверждена. '
           'Актуальность файлов не подтверждает действующую согласованную выдачу.')


class ReviewReport:
    def __init__(self, workspace, project_id):
        self.work = ReviewWork(workspace, project_id)

    def build(self, task_id, revision=None):
        identifier(task_id, 'task_id')
        if revision is not None:
            number(revision, 'revision', 1)
        work = self.work
        with connection(work.path, readonly=True) as db:
            # One DB snapshot, all selected units, independent of UI pagination.
            db.execute('begin')
            row = db.execute('select payload from review_tasks where task_id=? and '
                             '(? is null or revision=?) order by revision desc limit 1',
                             (task_id, revision, revision)).fetchone()
            if not row:
                raise ValueError('Unknown review task revision in this project')
            task = work.present(db, json.loads(row[0]), True, {})
            head = db.execute('select max(revision) from review_tasks where task_id=?', (task_id,)).fetchone()[0]
            rows, results = [], {}
            for unit in task['units']:
                analysis, check = None, {}
                if unit['result']:
                    analysis, _, check = work.result(db, unit['result'], results)
                sources = []
                # Include both the selected anchors and all dependencies of the pinned conclusion.
                dependencies = [{**d['source'], **{k:d[k] for k in ('table_id','engine') if d.get(k)}}
                                for d in analysis['dependencies']] if analysis else []
                for anchor in unit['sources'] + dependencies:
                    record, _ = work.workspace.source_record(work.project_id, anchor['doc_id'])
                    source = {k:anchor[k] for k in ('doc_id','sha256','page_number','table_id','row_number','engine') if k in anchor}
                    source['relative_path'] = record['relative_path']
                    if record['extension'] == '.pdf':
                        source['open_url'] = '/api/pdf?' + urlencode(dict(project_id=work.project_id,
                            doc_id=source['doc_id'], sha256=source['sha256'])) + '#page=' + str(source.get('page_number', 1))
                    elif source.get('table_id'):
                        source['open_url'] = '/?' + urlencode(dict(project=work.project_id,
                            structure_table=source['table_id'])) + '#structure'
                    if source not in sources:
                        sources.append(source)
                rows.append(dict(unit_id=unit['id'], title=unit['title'], state=unit['effective_state'],
                                 recorded_state=unit['state'], stale_reasons=unit['stale_reasons'],
                                 outcome=unit['outcome'] if unit['effective_state'] == 'reviewed' else 'unchecked',
                                 recorded_outcome=unit['outcome'], result=unit['result'],
                                 conclusion_title=check.get('title') if isinstance(check.get('title'), str) else '',
                                 detail=check.get('detail') if isinstance(check.get('detail'), str) else '',
                                 notes=unit['notes'], sources=sources,
                                 evidence_cells=analysis.get('evidence_cells', []) if analysis else [],
                                 analysis_summary=analysis['summary'] if analysis else ''))
        return bounded(dict(schema='uvyazka-review-report-1', project_id=work.project_id,
                            task_id=task_id, title=task['title'], scope=task['scope'],
                            revision=task['revision'], head_revision=head,
                            historical_revision=task['revision'] != head, generated_at=now(),
                            freshness_method='actual_hash', counts=task['counts'], outcomes=task['outcomes'],
                            next_action=task['next_action'], status=task['status'],
                            warning=WARNING, accepted=False, complete_project_review=False, rows=rows))

    def export(self, task_id, format='json', revision=None, panel_url=''):
        if format not in {'json', 'csv', 'markdown'}:
            raise ValueError('Report format must be json, csv or markdown')
        if panel_url:
            address = urlsplit(panel_url)
            if (address.scheme != 'http' or address.hostname not in {'localhost', '127.0.0.1'}
                    or address.username or address.password or address.path not in {'', '/'}
                    or address.query or address.fragment or any(c.isspace() for c in panel_url)):
                raise ValueError('panel_url must be an HTTP loopback origin')
            # Validate a supplied port as well; the renderer never fetches this URL.
            address.port
            panel_url = panel_url.rstrip('/')
        report = self.build(task_id, revision)
        for row in report['rows']:
            for source in row['sources']:
                if source.get('open_url'):
                    source['open_url'] = panel_url + source['open_url']
        if format == 'json':
            content = json.dumps(report, ensure_ascii=False, indent=2)
            mime, extension = 'application/json', 'json'
        elif format == 'csv':
            stream = io.StringIO(newline='')
            writer = csv.writer(stream, delimiter=';')
            columns = ['Проект', 'Проверка', 'Версия', 'Сформировано', 'Границы', 'Предупреждение',
                       'Всего выбрано', 'Разобрано', 'Перепроверить', 'Нужны данные',
                       'ID пункта', 'Условие', 'Состояние', 'Результат', 'Сохранённый результат',
                       'Вывод', 'Пояснение', 'Продолжение', 'Причины устаревания', 'Разбор', 'Источники', 'Ячейки']
            writer.writerow(columns)
            for row in report['rows']:
                values = [report['project_id'], task_id, report['revision'], report['generated_at'],
                          report['scope'], WARNING, report['counts']['total'], report['counts']['reviewed'],
                          report['counts']['needs_recheck'], report['counts']['blocked'], row['unit_id'],
                          row['title'], LABELS[row['state']], LABELS[row['outcome']],
                          LABELS[row['recorded_outcome']], row['conclusion_title'], row['detail'], row['notes'],
                          ', '.join(row['stale_reasons']), json.dumps(row['result'], ensure_ascii=False),
                          json.dumps(row['sources'], ensure_ascii=False), ', '.join(row['evidence_cells'])]
                # Spreadsheet applications must display source strings, never execute formulas.
                writer.writerow(["'" + str(v) if str(v).lstrip().startswith(('=', '+', '-', '@'))
                                 or str(v).startswith(('\t', '\r', '\n')) else v for v in values])
            content, mime, extension = '\ufeff' + stream.getvalue(), 'text/csv', 'csv'
        else:
            def esc(value):
                return re.sub(r'([\\`*\[\]!|])', r'\\\1', html.escape(str(value))).replace('\r', '').replace('\n', '<br>')
            registry = {}
            def source_id(source):
                key = json.dumps(source, sort_keys=True, ensure_ascii=False)
                if key not in registry:
                    registry[key] = (f'S{len(registry)+1}', source)
                return registry[key][0]
            lines = [f"# {esc(report['title'])}", '', WARNING, '',
                     f"Проект: {esc(report['project_id'])}. Проверка: {esc(task_id)}. Версия: {report['revision']} / {report['head_revision']}.",
                     f"Сформировано: {esc(report['generated_at'])}. Проверены фактические SHA-256.", '',
                     f"Границы: {esc(report['scope'])}", '',
                     'Состав: ' + ', '.join(f'{LABELS.get(k,k)}: {v}' for k,v in report['counts'].items()), '',
                     'Результаты актуально разобранных: ' + ', '.join(f'{LABELS[k]}: {v}' for k,v in report['outcomes'].items()), '']
            for row in report['rows']:
                lines += [f"## {esc(row['unit_id'])} · {esc(row['title'])}", '',
                          f"{LABELS[row['state']]} · {LABELS[row['outcome']]}", '']
                if row['conclusion_title'] and row['conclusion_title'] != row['title']:
                    lines += [esc(row['conclusion_title'])]
                lines += [esc(row['detail'])]
                if row['notes'] and row['notes'] != row['detail']:
                    lines += ['', 'Продолжение: ' + esc(row['notes'])]
                if row['stale_reasons']:
                    lines += ['Старый результат (не засчитывается): ' + LABELS[row['recorded_outcome']],
                              'Причины перепроверки: ' + esc(', '.join(row['stale_reasons']))]
                lines += ['', 'Зафиксированный разбор: ' + esc(json.dumps(row['result'], ensure_ascii=False)), '',
                          'Источники: ' + ', '.join(f'[{source_id(s)}](#источник-{source_id(s).lower()})' for s in row['sources'])]
                if row['evidence_cells']:
                    lines += ['', 'Ячейки: ' + esc(', '.join(row['evidence_cells']))]
                lines += ['']
            lines += ['## Адреса источников', '']
            for label, source in registry.values():
                lines += [f'### Источник {label}', '', esc(source['relative_path']), '',
                          'doc_id: ' + esc(source['doc_id']), 'SHA-256: ' + esc(source['sha256'])]
                if source.get('page_number'):
                    lines += ['Физическая страница PDF: ' + str(source['page_number'])]
                if source.get('table_id'):
                    lines += ['Таблица: ' + esc(source['table_id']) + (' · строка ' + str(source['row_number']) if source.get('row_number') else '')]
                if source.get('engine'):
                    lines += ['Обработчик: ' + esc(source['engine'])]
                if source.get('open_url'):
                    lines += ['', f"[Открыть источник]({source['open_url']})"]
                lines += ['']
            content, mime, extension = '\n'.join(lines), 'text/markdown', 'md'
        return bounded(dict(filename=f'{task_id}-r{report["revision"]}.{extension}',
                            content_type=mime + '; charset=utf-8', content=content))
