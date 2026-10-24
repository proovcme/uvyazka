"""The exported statement must not hide remaining work or revive stale conclusions."""
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.request import urlopen

from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.project_structure import ProjectStructure
from uvyazka.review_work import ReviewWork
from uvyazka.review_report import ReviewReport
from uvyazka.structure_analysis import StructureAnalysis


class ReviewReportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); sources = root/'sources'; sources.mkdir()
        self.source = sources/'equipment.csv'; self.source.write_text('Pump,10\n', encoding='utf-8')
        self.workspace = Workspace(root/'state'); self.workspace.create_project('p','Synthetic',sources)
        scan(self.workspace,'p'); structure = ProjectStructure(self.workspace,'p'); structure.build()
        table = structure.catalog('tables')['items'][0]; self.table_id = table['table_id']
        self.anchor = {k:table['source'][k] for k in ('doc_id','sha256')}
        self.anchor.update(table_id=self.table_id,row_number=1)
        self.work = ReviewWork(self.workspace,'p'); self.report = ReviewReport(self.workspace,'p')
        self.analyses = StructureAnalysis(self.workspace,'p')

    def create(self, count=3):
        self.work.create('selected','Equipment <script>','Selected conditions only',
                         [dict(id=f'u{i}',title='=HYPERLINK("bad")' if i==0 else f'Condition {i}',
                               sources=[self.anchor]) for i in range(count)],'create')

    def finish_first(self):
        self.analyses.save('check',self.table_id,'Pump','Identity not confirmed',
                           {'checks':[dict(id='quantity',status='question',title='Pump count',
                                           detail='10 assemblies vs 20 operations; clarify basis.')]},
                           'model','analysis',evidence_cells=[self.table_id+':1:2'])
        self.work.update('selected',[dict(unit_id='u0',state='reviewed',result=dict(
            analysis_id='check',reader='model',revision=1,check_id='quantity'))],1,'finish','Read first condition')

    def test_all_units_sources_and_questions_survive_export(self):
        self.create(105); self.finish_first()
        self.work.update('selected',[dict(unit_id='u104',state='blocked',notes='Need cabinet schematic')],
                         2,'blocked','Missing original')
        report=json.loads(self.report.export('selected')['content'])
        self.assertEqual(len(report['rows']),105)
        self.assertEqual(report['counts']['reviewed'],1); self.assertEqual(report['counts']['blocked'],1)
        self.assertEqual(report['outcomes']['question'],1); self.assertFalse(report['complete_project_review'])
        first=report['rows'][0]
        self.assertEqual(first['detail'],'10 assemblies vs 20 operations; clarify basis.')
        self.assertEqual(first['sources'][0]['relative_path'],'equipment.csv')
        self.assertEqual(first['sources'][0]['row_number'],1)
        self.assertEqual(first['sources'][0]['sha256'],self.anchor['sha256'])
        self.assertEqual(first['evidence_cells'],[self.table_id+':1:2'])
        self.assertEqual(report['rows'][-1]['notes'],'Need cabinet schematic')
        self.assertEqual(report['next_action']['unit_id'],'u1')

    def test_old_analysis_pinned_detail_retained_but_not_counted_as_current(self):
        self.create(); self.finish_first()
        self.analyses.save('check',self.table_id,'Pump','Updated meaning',
            {'checks':[dict(id='quantity',status='match',title='New conclusion',detail='Do not overwrite old text')]},
            'model','analysis-2',expected_revision=1,reason='New evidence')
        report=self.report.build('selected')
        self.assertEqual(report['counts']['reviewed'],0)
        self.assertEqual(report['rows'][0]['outcome'],'unchecked')
        self.assertEqual(report['rows'][0]['recorded_outcome'],'question')
        self.assertEqual(report['rows'][0]['result']['revision'],1)
        self.assertIn('clarify basis',report['rows'][0]['detail'])
        self.assertIn('analysis_revision_changed',report['rows'][0]['stale_reasons'])
        historical=self.report.build('selected',revision=1)
        self.assertTrue(historical['historical_revision']); self.assertEqual(historical['counts']['pending'],3)
        markdown=self.report.export('selected','markdown')['content']
        self.assertIn('Старый результат (не засчитывается)',markdown)

    def test_actual_bytes_not_metadata_invalidate_all_selected_work(self):
        self.create(); self.finish_first()
        self.source.write_text('Pump,99\n',encoding='utf-8')
        report=self.report.build('selected')
        self.assertEqual(report['counts']['needs_recheck'],3)
        self.assertEqual(report['outcomes']['question'],0)
        self.assertEqual(report['rows'][0]['sources'][0]['sha256'],self.anchor['sha256'])

    def test_portable_formats_escape_markup_and_spreadsheet_formulas(self):
        self.create(); self.finish_first()
        exported=self.report.export('selected','csv')
        self.assertTrue(exported['content'].startswith('\ufeff'))
        rows=list(csv.reader(io.StringIO(exported['content'].lstrip('\ufeff')),delimiter=';'))
        self.assertEqual(len(rows),4)
        self.assertTrue(rows[1][11].startswith("'=HYPERLINK"))
        self.assertIn('Только выбранный состав',rows[1][5])
        markdown=self.report.export('selected','markdown')['content']
        self.assertNotIn('<script>',markdown); self.assertIn('&lt;script&gt;',markdown)
        self.assertIn(self.anchor['sha256'],markdown)
        linked=self.report.export('selected','markdown',panel_url='http://127.0.0.1:8765')['content']
        self.assertIn('[Открыть источник](http://127.0.0.1:8765/?project=p',linked)
        self.assertEqual(markdown.count('### Источник S1'),1)
        self.assertIn('[S1](#источник-s1)',markdown)
        for bad in ['https://example.com', 'http://localhost/path', 'http://user@localhost', 'http://localhost:bad', 'http://localhost\n']:
            with self.assertRaises(ValueError): self.report.export('selected',panel_url=bad)
        with self.assertRaises(ValueError): self.report.export('selected','xlsx')
        with self.assertRaises(ValueError): self.report.build('../other')
        with self.assertRaises(ValueError): self.report.build('missing')

    def test_loopback_download_matches_core_report_and_project_isolation(self):
        from uvyazka.dashboard import make_handler
        self.create(); self.finish_first()
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.workspace))
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            base=f'http://127.0.0.1:{server.server_port}/api/structure/report?project_id=p&task_id=selected'
            with urlopen(base+'&format=json') as response:
                report=json.load(response)
            self.assertEqual(report['rows'][0]['result']['check_id'],'quantity')
            self.assertTrue(report['rows'][0]['sources'][0]['open_url'].startswith(f'http://127.0.0.1:{server.server_port}/?'))
            with urlopen(base+'&format=csv') as response:
                self.assertIn('text/csv',response.headers['Content-Type'])
                self.assertTrue(response.read().startswith(b'\xef\xbb\xbf'))
            self.workspace.create_project('other','Other',self.source.parent)
            with self.assertRaises(ValueError): ReviewReport(self.workspace,'other').build('selected')
        finally:
            server.shutdown();server.server_close();thread.join()
