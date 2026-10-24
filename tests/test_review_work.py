"""Synthetic scoped work: resume, source/result invalidation and human handoff."""
import json
from pathlib import Path
import tempfile
import unittest
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.project_structure import ProjectStructure
from uvyazka.review_work import ReviewWork
from uvyazka.structure_analysis import StructureAnalysis


class ReviewWorkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name);self.sources=root/'input';self.sources.mkdir()
        self.source=self.sources/'rows.csv';self.source.write_text('Pump,10\nFan,3\n',encoding='utf-8')
        self.workspace=Workspace(root/'state');self.workspace.create_project('p','Synthetic',self.sources)
        scan(self.workspace,'p');self.structure=ProjectStructure(self.workspace,'p');self.structure.build()
        self.table=self.structure.catalog('tables')['items'][0]
        self.anchor={k:self.table['source'][k] for k in ('doc_id','sha256')}
        self.work=ReviewWork(self.workspace,'p');self.analyses=StructureAnalysis(self.workspace,'p')

    def create(self):
        return self.work.create('scope','Selected equipment','Two selected source rows; no whole-project claim.',
            [dict(id='pump',title='Pump row',sources=[{**self.anchor,'table_id':self.table['table_id'],'row_number':1}]),
             dict(id='fan',title='Fan row',sources=[{**self.anchor,'table_id':self.table['table_id'],'row_number':2}])], 'create')

    def note(self,revision=0,status='question'):
        return self.analyses.save('check',self.table['table_id'],'Pump','Need the cabinet diagram.',
            {'checks':[dict(id='count',status=status,title='Pump quantity')]},'model','note-'+str(revision),
            expected_revision=revision,reason='New evidence' if revision else '')

    def ref(self,revision=1):
        return dict(analysis_id='check',reader='model',revision=revision,check_id='count')

    def test_resume_human_history_and_question_is_reviewed_not_approved(self):
        receipt=self.create();self.assertEqual(self.create(),receipt)
        first=self.work.get('scope',unit_limit=1)
        self.assertEqual(first['counts']['total'],2);self.assertEqual(len(first['units']),1)
        self.assertEqual(first['next_unit_offset'],1);self.assertEqual(first['next_action']['unit_id'],'pump')
        self.note()
        update=[dict(unit_id='pump',state='reviewed',result=self.ref()),dict(unit_id='fan',state='blocked',notes='Need the matching specification')]
        saved=self.work.update('scope',update,1,'progress','Read the first row')
        self.assertEqual(self.work.update('scope',update,1,'progress','Read the first row'),saved)
        state=self.work.get('scope');self.assertEqual(state['counts']['reviewed'],1)
        self.assertEqual(state['outcomes']['question'],1);self.assertFalse(state['accepted'])
        self.assertIsNone(state['next_action']);self.assertEqual(state['status'],'blocked')
        self.work.update('scope',[dict(unit_id='pump',notes='Human investigated the question')],2,'human','Continue model work','human')
        self.assertEqual(self.work.get('scope')['units'][0]['actor'],'human')
        history=self.work.get('scope',revision=1);self.assertTrue(history['historical_revision'])
        self.assertEqual(history['counts']['pending'],2);self.assertEqual(history['head_revision'],3)
        with self.assertRaisesRegex(ValueError,'revision conflict'):
            self.work.update('scope',[dict(unit_id='fan',state='working')],2,'conflict','Old session')

    def test_inventory_cannot_shrink_and_review_needs_exact_current_check(self):
        self.create()
        with self.assertRaisesRegex(ValueError,'already exists'):
            self.work.create('scope','Reduced','Drop the hard row',[dict(id='pump',title='Only row',sources=[self.anchor])],'drop')
        with self.assertRaisesRegex(ValueError,'pinned result'):
            self.work.update('scope',[dict(unit_id='pump',state='reviewed')],1,'missing','Missing result')
        self.note(status='unchecked')
        with self.assertRaisesRegex(ValueError,'Unchecked result'):
            self.work.update('scope',[dict(unit_id='pump',state='reviewed',result=self.ref())],1,'unchecked','Still unread')
        with self.assertRaisesRegex(ValueError,'one check'):
            self.work.update('scope',[dict(unit_id='pump',state='reviewed',result={**self.ref(),'check_id':'unknown'})],1,'bad-check','Wrong check')
        with self.assertRaisesRegex(ValueError,'duplicate unit'):
            self.work.update('scope',[dict(unit_id='fan',state='working')]*2,1,'twice','Duplicate')
        self.assertEqual(self.work.get('scope')['revision'],1)

    def test_result_revision_change_invalidates_completion_and_unrelated_work_can_continue(self):
        self.create();self.note(status='match')
        self.work.update('scope',[dict(unit_id='pump',state='reviewed',result=self.ref())],1,'done','Read quantity')
        self.note(revision=1,status='discrepancy')
        state=self.work.get('scope');self.assertEqual(state['counts']['reviewed'],0)
        self.assertEqual(state['units'][0]['stale_reasons'],['analysis_revision_changed'])
        self.assertEqual(state['next_action'],dict(unit_id='pump',action='refresh_dependencies'))
        # A human note on another unit must not silently approve or block the stale result.
        self.work.update('scope',[dict(unit_id='fan',notes='Continue here')],2,'other','Human continuation','human')
        with self.assertRaisesRegex(ValueError,'Result changed'):
            self.work.update('scope',[dict(unit_id='pump',state='reviewed')],3,'old-ref','Retry old result')
        self.work.update('scope',[dict(unit_id='pump',result=self.ref(2))],3,'rebase','Read the revised finding')
        state=self.work.get('scope');self.assertEqual(state['counts']['reviewed'],1)
        self.assertEqual(state['outcomes']['discrepancy'],1)

    def test_actual_source_bytes_invalidate_work_and_rebase_preserves_history(self):
        self.create();self.note(status='match')
        self.work.update('scope',[dict(unit_id='pump',state='reviewed',result=self.ref())],1,'read','Read source')
        self.source.write_text('Pump,99\nFan,3\n',encoding='utf-8')
        self.assertEqual(self.work.get('scope')['counts']['needs_recheck'],2)
        with self.assertRaisesRegex(ValueError,'Source changed'):
            self.work.create('new','Changed','Old hash',[dict(id='p',title='Pump',sources=[self.anchor])],'changed')
        scan(self.workspace,'p');self.structure.build();new_table=self.structure.catalog('tables')['items'][0]
        new_source={k:new_table['source'][k] for k in ('doc_id','sha256')}
        self.analyses.save('check',new_table['table_id'],'Pump','Re-read current source',{'checks':[dict(id='count',status='question',title='Quantity changed')]},
            'model','new-source',expected_revision=1,reason='Source bytes changed')
        self.work.update('scope',[dict(unit_id='pump',sources=[{**new_source,'table_id':new_table['table_id'],'row_number':1}],result=self.ref(2))],2,'refresh','Rebase selected row')
        current=self.work.get('scope');self.assertEqual(current['counts']['reviewed'],1)
        self.assertEqual(current['counts']['needs_recheck'],1)
        self.assertEqual(self.work.get('scope',revision=2)['units'][0]['sources'][0]['sha256'],self.anchor['sha256'])

    def test_source_boundaries_and_result_must_cite_the_unit_sources(self):
        with self.assertRaisesRegex(ValueError,'Unknown source row'):
            self.work.create('bad','Bad','Bad row',[dict(id='p',title='Pump',sources=[{**self.anchor,'table_id':self.table['table_id'],'row_number':100}])],'bad')
        self.workspace.create_project('other','Other',self.sources)
        with self.assertRaises(ValueError):
            ReviewWork(self.workspace,'other').create('bad','Bad','Foreign doc',[dict(id='p',title='Pump',sources=[self.anchor])],'foreign')
        with self.assertRaisesRegex(ValueError,'Duplicate unit'):
            self.work.create('dup','Duplicate','Duplicate units',[dict(id='p',title='Pump',sources=[self.anchor])]*2,'duplicate')
        # File-level anchors also support scans that have no detected table.
        self.work.create('file','File','Selected file',[dict(id='p',title='Pump',sources=[self.anchor])],'file')
        (self.sources/'other.csv').write_text('Unrelated,1\n',encoding='utf-8');scan(self.workspace,'p');self.structure.build()
        other=next(t for t in self.structure.catalog('tables')['items'] if t['source']['doc_id']!=self.anchor['doc_id'])
        self.analyses.save('unrelated',other['table_id'],'Other','Other source',{'checks':[dict(id='c',status='match')]},'model','unrelated')
        with self.assertRaisesRegex(ValueError,'every selected unit source'):
            self.work.update('file',[dict(unit_id='p',state='reviewed',result=dict(analysis_id='unrelated',reader='model',revision=1,check_id='c'))],1,'wrong','Wrong evidence')

    def test_http_shared_work_and_write_protection(self):
        from uvyazka.dashboard import make_handler
        self.create();server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.workspace));thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}/api/structure/'
        try:
            with urlopen(base+'config') as r:token=json.load(r)['write_token']
            with urlopen(base+'tasks?project_id=p&task_id=scope') as r:self.assertEqual(json.load(r)['counts']['pending'],2)
            payload=dict(task_id='scope',updates=[dict(unit_id='pump',state='working',notes='Human reads original')],expected_revision=1,request_id='http',reason='Human continuation',actor='human')
            req=Request(base+'task-update?project_id=p',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
            with self.assertRaises(HTTPError) as error:urlopen(req)
            self.assertEqual(error.exception.code,403)
            req.add_header('X-Uvyazka-Token',token)
            with urlopen(req) as r:self.assertEqual(json.load(r)['revision'],2)
            self.assertEqual(self.work.get('scope')['units'][0]['state'],'working')
            req.add_header('Origin','https://example.org')
            with self.assertRaises(HTTPError) as error:urlopen(req)
            self.assertEqual(error.exception.code,403)
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
