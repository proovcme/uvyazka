"""Exact source arithmetic, cached-result disagreement and explicit unsupported work."""
from pathlib import Path
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.project_structure import ProjectStructure
from uvyazka.structure_calculation import StructureCalculation


class StructureCalculationTests(unittest.TestCase):
    def setUp(self):
        try:from openpyxl import Workbook
        except ImportError:self.skipTest('readers extra missing')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name);self.sources=root/'sources';self.sources.mkdir()
        self.source=self.sources/'work.xlsx';book=Workbook();s=book.active
        s['A1']=100;s['A2']=7;s['A3']='=3*11';s['A4']='=A1-A2-A3';s['A5']='=A4+A2+A3'
        s['B1']='=0.1+0.2';s['B2']='=B1/3';s['B3']='=1/3';s['B4']='=A4*2'
        s['C1']=False;s['C2']='12';s['C3']='=SUM(A1:A3)';s['C4']="='Other'!A1";s['C5']='=C6';s['C6']='=C5'
        s['D1']='=A1/0';s['D2']='=2**10';s['D3']='=1e101';s['D4']='=D5';s['D5']='=A1'
        s['E1']=2;s.merge_cells('E1:F1');book.save(self.source);book.close()
        self.workspace=Workspace(root/'state');self.workspace.create_project('p','Synthetic',self.sources)
        self.refresh()

    def refresh(self):
        scan(self.workspace,'p');self.structure=ProjectStructure(self.workspace,'p');self.structure.build()
        self.table=self.structure.catalog('tables')['items'][0]['table_id'];self.calc=StructureCalculation(self.workspace,'p')

    def test_recursive_exact_recalculation_absolute_refs_and_trace(self):
        before=self.source.read_bytes();result=self.calc.calculate(self.table,'=$a$4+A2+A3')
        self.assertEqual(result['result']['value'],'100');self.assertFalse(result['accepted'])
        cells={c['address']:c for c in result['cells']}
        self.assertEqual(set(cells),{'A1','A2','A3','A4'})
        self.assertEqual(cells['A4']['calculated']['value'],'60');self.assertEqual(cells['A4']['cache_comparison'],'missing')
        self.assertEqual(cells['A4']['cell_id'],self.table+':4:1')
        self.assertEqual(self.calc.calculate(self.table,'B1')['result']['value'],'0.3')
        self.assertEqual(self.calc.calculate(self.table,'B2')['result']['value'],'0.1')
        third=self.calc.calculate(self.table,'B3')['result'];self.assertEqual(third['exact'],'1/3')
        self.assertFalse(third['terminating_decimal']);self.assertEqual(self.source.read_bytes(),before)

    def test_long_terminating_decimal_keeps_all_digits(self):
        from fractions import Fraction
        from uvyazka.structure_calculation import result_number
        value=Fraction(2**2000-1,2**2000)
        result=result_number(value)
        self.assertTrue(result['terminating_decimal'])
        self.assertEqual(Fraction(result['value']),value)
        self.assertEqual(len(result['value'].split('.')[1]),2000)

    def test_saved_formula_cache_is_compared_and_never_substituted(self):
        # OOXML fixture: supported A4 formula has an intentionally stale saved result.
        ns='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
        with zipfile.ZipFile(self.source) as z:entries={n:z.read(n) for n in z.namelist()}
        root=ET.fromstring(entries['xl/worksheets/sheet1.xml'])
        for c in root.iter(ns+'c'):
            if c.attrib['r']=='A4':c.find(ns+'v').text='99'
        entries['xl/worksheets/sheet1.xml']=ET.tostring(root)
        with zipfile.ZipFile(self.source,'w') as z:
            for n,data in entries.items():z.writestr(n,data)
        self.refresh();result=self.calc.calculate(self.table,'A4')
        cell=next(c for c in result['cells'] if c['address']=='A4')
        self.assertEqual(result['result']['value'],'60');self.assertEqual(cell['cached_value'],'99')
        self.assertEqual(cell['cache_comparison'],'differs');self.assertEqual(result['cached_discrepancies'],1)

    def test_unsupported_functions_links_ranges_and_cycles_fail_explicitly(self):
        for expression in ['C3','C4','C5','D1','D2','A1:A3','SUM(A1)','A1//3','A1%3','A1[0]','__import__(1)']:
            with self.subTest(expression=expression),self.assertRaises(ValueError):self.calc.calculate(self.table,expression)
        for expression in ['C1','C2','E2','F1','Z1000','D3']:
            with self.subTest(expression=expression),self.assertRaises(ValueError):self.calc.calculate(self.table,expression)
        with self.assertRaisesRegex(ValueError,'Circular reference'):self.calc.calculate(self.table,'C5')

    def test_bounds_source_change_and_project_isolation(self):
        with self.assertRaises(ValueError):self.calc.calculate(self.table,'1+'*1100+'1')
        self.workspace.create_project('other','Other',self.sources)
        with self.assertRaises(ValueError):StructureCalculation(self.workspace,'other').calculate(self.table,'A1')
        self.source.write_bytes(self.source.read_bytes()+b'\nchanged')
        with self.assertRaisesRegex(ValueError,'Source or reader changed'):self.calc.calculate(self.table,'A1')

    def test_http_uses_the_same_literal_source_calculation(self):
        import json
        from http.server import ThreadingHTTPServer
        from threading import Thread
        from urllib.parse import urlencode
        from urllib.request import urlopen
        from uvyazka.dashboard import make_handler
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.workspace));thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            url=f'http://127.0.0.1:{server.server_port}/api/structure/calculate?'+urlencode(dict(project_id='p',table_id=self.table,expression='A5'))
            with urlopen(url) as response:result=json.load(response)
            self.assertEqual(result['result']['value'],'100');self.assertEqual(result['source_freshness'],'actual_hash_matches')
        finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
