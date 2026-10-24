"""Source/version invariants and protocol faults; real retrieval quality is evaluated separately."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.request import urlopen,Request
from urllib.parse import urlencode
from urllib.error import HTTPError

from uvyazka.core import Workspace,connection
from uvyazka.ingest import scan
from uvyazka.embedding_worker import EmbeddingWorker,WorkerError,close_providers
from uvyazka.semantic_search import SemanticSearch,windows

FIXTURE=Path(__file__).parent/'fixtures/embedding_worker.py'


class SemanticTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        root=Path(temporary.name);self.sources=root/'sources';self.sources.mkdir()
        self.source=self.sources/'mechanical.txt'
        self.source.write_text('Повысительная установка ХВС Н-1. '+('Параметры системы. '*100)+'\nНасосная второго этажа Н-10.',encoding='utf-8')
        (self.sources/'ventilation.txt').write_text('Вентилятор П1 обеспечивает приток воздуха.',encoding='utf-8')
        self.workspace=Workspace(root/'state');self.workspace.create_project('p','Synthetic',self.sources);scan(self.workspace,'p')
        self.service=SemanticSearch(self.workspace,'p')
        self.config=dict(command=[sys.executable,str(FIXTURE)],models=str(root))
        (self.workspace.home/'embedding-worker.json').write_text(json.dumps(self.config),encoding='utf-8')
        self.addCleanup(close_providers)

    def build_all(self):
        result=self.service.build(limit=1)
        self.assertEqual(len(result['processed']),1)
        while result['status']['counts']['pending']:
            result=self.service.build(limit=64)
        return result

    def test_persistent_vectors_multiple_fragments_and_no_api_dependency(self):
        result=self.build_all();self.assertEqual(result['status']['counts']['failed'],0)
        self.assertEqual(result['status']['prepared_documents'],2)
        self.assertEqual(result['status']['cached_documents'],2)
        first=self.service.search('насосная',mode='semantic')
        self.assertEqual(first['effective_mode'],'semantic');self.assertGreater(len(first['results']),1)
        self.assertEqual(len({r['doc_id'] for r in first['results']}),1)
        self.assertTrue(all(r['sha256'] and 'char_start' in r and r['locator'] for r in first['results']))
        close_providers()
        resumed=SemanticSearch(self.workspace,'p');self.assertEqual(resumed.build(limit=64)['processed'],[])
        self.assertEqual(resumed.search('насосная')['status']['counts']['ready'],result['status']['counts']['ready'])
        self.assertFalse(first['accepted']);self.assertFalse(first['complete_project_review'])

    def test_exact_numbered_id_does_not_match_other_equipment(self):
        (self.sources/'other-ids.txt').write_text('Н 1. Н-1.1. Н-1/2.',encoding='utf-8');scan(self.workspace,'p')
        self.build_all()
        result=self.service.search('Н-1')
        self.assertEqual(result['effective_mode'],'literal')
        self.assertEqual(result['fallback_reason'],'identifier_lookup_uses_exact_terms')
        self.assertTrue(result['results']);self.assertTrue(all('Н-1.' in r['snippet'] for r in result['results']))
        self.assertEqual({r['relative_path'] for r in result['results']},{'mechanical.txt'})
        self.assertFalse(self.service.search('Н-100')['results'])

    def test_changed_bytes_without_metadata_change_are_never_returned(self):
        self.build_all();before=self.source.stat()
        self.source.write_bytes(self.source.read_bytes().replace('ХВС'.encode(),'ГВС'.encode()))
        os.utime(self.source,ns=(before.st_atime_ns,before.st_mtime_ns))
        result=self.service.search('насосная',mode='semantic')
        self.assertFalse(result['results'])
        self.assertFalse(self.service.search('ХВС',mode='literal')['results'])

    def test_model_revision_isolated_and_project_scope_precedes_ranking(self):
        self.build_all();old=self.service.status()['active_space']['space_id']
        self.workspace.create_project('other','Other',self.sources);scan(self.workspace,'other')
        other=SemanticSearch(self.workspace,'other')
        self.assertEqual(other.status()['prepared_documents'],0)
        self.assertEqual(other.status()['cached_documents'],2)
        self.assertEqual(other.search('насосная')['fallback_reason'],'index_not_prepared')
        self.config['command'].append('--revision=fixture2')
        (self.workspace.home/'embedding-worker.json').write_text(json.dumps(self.config),encoding='utf-8')
        self.assertEqual(self.service.search('насосная')['fallback_reason'],'index_model_changed')
        self.build_all();self.assertNotEqual(self.service.status()['active_space']['space_id'],old)
        with connection(self.workspace.db_path('p'),readonly=True) as db:
            self.assertEqual(db.execute('select count(distinct space_id) from semantic_vectors').fetchone()[0],2)

    def test_explicit_fallback_and_invalid_queries(self):
        (self.workspace.home/'embedding-worker.json').unlink()
        result=self.service.search('Вентилятор')
        self.assertEqual(result['fallback_reason'],'worker_not_configured');self.assertTrue(result['results'])
        for args in [dict(query=''),dict(query='test',mode='unknown'),dict(query='test',min_similarity=float('nan'))]:
            with self.assertRaises(ValueError):self.service.search(**args)

    def test_changed_weight_bytes_invalidate_even_with_same_reported_model_revision(self):
        weights=Path(self.config['models'])/'embeddinggemma-2-Q8_0.gguf'
        weights.write_bytes(b'fixture-v1');self.build_all()
        old=self.service.status()['active_space']['space_id'];stat=weights.stat()
        close_providers();weights.write_bytes(b'fixture-v2');os.utime(weights,ns=(stat.st_atime_ns,stat.st_mtime_ns))
        self.assertEqual(self.service.search('насосная')['fallback_reason'],'index_model_changed')
        self.build_all();self.assertNotEqual(self.service.status()['active_space']['space_id'],old)

    def test_utf8_windows_retain_original_offsets_and_budget(self):
        text='Система ХВС🙂 '*300
        pieces=list(windows(text));self.assertGreater(len(pieces),1)
        self.assertEqual(pieces[0][0],0);self.assertEqual(pieces[-1][1],len(text))
        for start,end,value in pieces:
            self.assertEqual(value,text[start:end]);self.assertLessEqual(len(value.encode()),1000)
        self.assertTrue(all(b[0]<a[1] for a,b in zip(pieces,pieces[1:])))

    def test_worker_rejects_malformed_nonfinite_and_out_of_order_vectors(self):
        for fault in ['nan','shape','id']:
            with EmbeddingWorker({**self.config,'command':self.config['command']+['--fault='+fault]}) as worker:
                with self.assertRaises(WorkerError):worker.embed(['насос'])
        with self.assertRaisesRegex(WorkerError,'timed out'):
            EmbeddingWorker({**self.config,'command':self.config['command']+['--fault=timeout']},timeout=0.05)

    def test_saved_pdf_region_has_own_revision_and_is_not_full_scan_coverage(self):
        try:import pymupdf
        except ImportError:self.skipTest('readers extra not installed')
        from uvyazka.measurements import Measurements
        with pymupdf.open() as pdf:
            page=pdf.new_page(width=600,height=400);page.draw_rect((30,60,130,160));page.set_rotation(90)
            pdf.save(self.sources/'scheme.pdf')
        scan(self.workspace,'p')
        doc=next(d for d in self.workspace.find_documents('p')['documents'] if d['relative_path']=='scheme.pdf')
        view=dict(id='pump',doc_id=doc['doc_id'],sha256=doc['sha256'],page_number=1,name='Насосная',
                  kind='scheme',region=[10,10,290,380],measurement_basis='source_region',reason='Synthetic image region')
        store=Measurements(self.workspace,'p');store.save_view(view,0,'create-image')
        built=self.service.build(limit=64,doc_ids=[doc['doc_id']]);self.assertEqual(len(built['processed']),1)
        hit=self.service.search('насосная',mode='semantic')['results'][0]
        self.assertEqual(hit['locator']['region'],view['region']);self.assertEqual(hit['locator']['view_revision'],1)
        store.save_view({**view,'region':[20,20,290,380]},1,'update-image')
        self.assertFalse(self.service.search('насосная',mode='semantic')['results'])
        self.service.build(limit=64,doc_ids=[doc['doc_id']])
        self.assertEqual(self.service.search('насосная',mode='semantic')['results'][0]['locator']['view_revision'],2)

    def test_http_build_requires_local_write_token(self):
        from uvyazka.dashboard import make_handler
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.workspace));thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        try:
            with urlopen(base+'/api/structure/config') as response:token=json.load(response)['write_token']
            request=Request(base+'/api/semantic/build?project_id=p',data=b'{"limit":1}',headers={'Content-Type':'application/json'},method='POST')
            with self.assertRaises(HTTPError) as error:urlopen(request)
            self.assertEqual(error.exception.code,403)
            request.add_header('X-Uvyazka-Token',token)
            with urlopen(request) as response:self.assertEqual(len(json.load(response)['processed']),1)
            with urlopen(base+'/api/semantic/search?'+urlencode(dict(project_id='p',mode='literal',q='Н-100'))) as response:
                self.assertEqual(json.load(response)['results'],[])
        finally:server.shutdown();server.server_close();thread.join()
