from pathlib import Path
import json
import tempfile
import unittest

from uvyazka.core import Workspace, connection
from uvyazka.ingest import scan
from uvyazka.project_summary import ProjectSummary,extract_candidates


class ProjectSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name);self.source=root/'sources';self.source.mkdir()
        self.ws=Workspace(root/'state');self.ws.create_project('sample','Synthetic',self.source)
        self.summary=ProjectSummary(self.ws,'sample')

    def test_units_ranges_and_raw_evidence_are_not_accepted_facts(self):
        items,truncated=extract_candidates('Площадь 1 234,50 м²; мощность 20–30 кВт; допуск 10 ± 2 мм',{'kind':'pdf_page','pdf_page':2})
        self.assertEqual([i['raw_value'] for i in items],['1 234,50','20–30','10 ± 2'])
        self.assertEqual(items[0]['value'],'1234.50')
        self.assertIsNone(items[1]['value']);self.assertIsNone(items[2]['value'])
        self.assertTrue(all(i['status']=='automatic_candidate' for i in items));self.assertFalse(truncated)
        self.assertEqual(extract_candidates('Шифр АР-2021.12 лист 103',{'kind':'pdf_page'})[0],[])

    def test_table_quantity_keeps_unit_and_row_but_numeric_cells_are_not_units(self):
        items,_=extract_candidates('1 | Площадь застройки | м2 | 123,4',{'kind':'docx_table_row','table':2,'row':3})
        self.assertEqual(items[0]['label'],'Площадь застройки');self.assertEqual(items[0]['value'],'123.4')
        self.assertEqual(items[0]['column'],4);self.assertEqual(items[0]['locator']['row'],3)
        self.assertEqual(extract_candidates('Этажность, секции | 1 | 2',{'kind':'docx_table_row'})[0],[])
        items,_=extract_candidates('2 | Этажность | этаж | 1-3',{'kind':'docx_table_row'})
        self.assertEqual(items[0]['raw_unit'],'этаж');self.assertIsNone(items[0]['value'])

    def test_incremental_cache_revision_isolation_and_readonly_summary(self):
        source=self.source/'AR.txt';source.write_text('Площадь 123,4 м2.\nМощность 25 кВт.',encoding='utf-8')
        scan(self.ws,'sample');before=self.ws.db_path('sample').read_bytes()
        empty=self.summary.read();self.assertEqual(empty['state']['remaining_blocks'],2)
        self.assertEqual(before,self.ws.db_path('sample').read_bytes())
        one=self.summary.index(1);self.assertEqual(one['processed_pages'],1);self.assertEqual(one['remaining_blocks'],1)
        self.summary.index();self.assertEqual(self.summary.index()['processed_pages'],0)
        first=self.summary.read(query='Площадь');self.assertEqual(first['total'],1)
        self.assertEqual(first['items'][0]['raw_value'],'123,4')
        self.assertEqual(self.ws.get_project_facts('sample')['facts'],[])
        old=first['items'][0]['source'];source.write_text('Площадь 125 м2.',encoding='utf-8');scan(self.ws,'sample')
        self.assertEqual(self.summary.read()['state']['candidate_count'],0)
        self.summary.index();self.assertEqual(self.summary.read()['items'][0]['value'],'125')
        self.assertIn('123,4',self.ws.read_evidence('sample',old['doc_id'],old['page_number'],sha256=old['sha256'])['text'])

    def test_per_block_limit_is_explicit_and_pagination_continues(self):
        text='; '.join('Длина '+str(i)+' мм' for i in range(400))
        items,truncated=extract_candidates(text,{'kind':'text_line'},limit=30)
        self.assertTrue(truncated);self.assertEqual(len(items),30)
        (self.source/'AR.txt').write_text(text,encoding='utf-8');scan(self.ws,'sample');self.summary.index()
        result=self.summary.read(limit=10)
        self.assertEqual(result['state']['truncated_blocks'],1);self.assertEqual(result['next_offset'],10)
        self.assertNotEqual(result['items'][0]['candidate_id'],self.summary.read(offset=10,limit=10)['items'][0]['candidate_id'])
