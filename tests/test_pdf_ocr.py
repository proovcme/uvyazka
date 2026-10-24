import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.pdf_ocr import PdfOCR, engine_info


class PdfOCRTests(unittest.TestCase):
    def setUp(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest('readers extra missing')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'source';self.root.mkdir()
        self.source=self.root/'scan.pdf'
        with pymupdf.open() as doc:
            doc.new_page(width=300,height=200)
            doc.new_page(width=300,height=200).insert_text((20,40),'Native 24 hours')
            doc.save(self.source)
        self.workspace=Workspace(Path(self.temp.name)/'state')
        self.workspace.create_project('p','OCR fixture',str(self.root))
        scan(self.workspace,'p')
        self.record=self.workspace.find_documents('p')['documents'][0]
        self.service=PdfOCR(self.workspace)

    def fake(self):
        return {'text':'Battery 12 Ah', 'words':[{'text':'12','bbox_pt':[10,20,30,40],'confidence':90,'line':[1,1,1]}],
                'actual_dpi':300,'page_rect_pt':[0,0,300,200], 'rotation':0, 'coordinate_space':'rendered_page_points_top_left'}

    def test_immutable_versions_cache_search_and_word_provenance(self):
        before=self.source.read_bytes()
        engine={'binary':'test','version':'fixture-1','engine':'Tesseract'}
        with patch('uvyazka.pdf_ocr.engine_info', return_value=engine),patch('uvyazka.pdf_ocr.recognize',return_value=self.fake()) as recognize:
            result=self.service.extract('p',self.record['doc_id'],[1],'ocr-one',word_limit=1)
            repeat=self.service.extract('p',self.record['doc_id'],[1],'ocr-one',word_limit=1)
            self.assertEqual(recognize.call_count,1);self.assertTrue(repeat['cache_reused'])
        evidence=self.workspace.read_evidence('p',self.record['doc_id'],1)
        self.assertIn('12 Ah',evidence['text']);self.assertTrue(evidence['locator']['requires_visual_review'])
        self.assertFalse(evidence['locator']['table_structure_verified'])
        old=self.workspace.read_evidence('p',self.record['doc_id'],1,parser_revision=self.record['parser_revision'])
        self.assertEqual(old['text'],'');self.assertEqual(old['freshness']['status'],'historical_snapshot')
        self.assertEqual(result['pages'][0]['words'][0]['bbox_pt'],[10,20,30,40])
        self.assertTrue(self.workspace.search_project('p','Battery')['results'])
        source={'doc_id':self.record['doc_id'],'sha256':self.record['sha256'],'parser_revision':result['parser_revision'],'page_number':1}
        self.workspace.record_observations('p',[{'name':'Battery capacity','group':'capacity','value':'12','raw_value':'12','unit':'Ah',
            'basis':'nominal','sources':[source]}],'battery-observation')
        self.assertEqual(self.workspace.get_project_facts('p')['facts'][0]['status'],'source_observation')
        current=result['parser_revision'];scan(self.workspace,'p')
        self.assertEqual(self.workspace.find_documents('p')['documents'][0]['parser_revision'],current)
        self.assertEqual(self.source.read_bytes(),before)
        with self.assertRaises(ValueError):self.service.extract('p',self.record['doc_id'],[2],'ocr-one')
        self.source.write_bytes(before+b'\nchanged')
        with self.assertRaises(ValueError):self.service.extract('p',self.record['doc_id'],[1],'ocr-one')

    def test_tesseract_literal_quotes_do_not_consume_following_tsv_rows(self):
        import pymupdf
        from types import SimpleNamespace
        from uvyazka.pdf_ocr import recognize
        header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
        rows='5\t1\t1\t1\t1\t1\t10\t10\t10\t10\t95\t"\n5\t1\t1\t1\t2\t1\t10\t30\t20\t10\t96\t12.50\n'
        with pymupdf.open(self.source) as pdf,patch('uvyazka.pdf_ocr.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=header+rows)):
            result=recognize(pdf[0],{'binary':'fixture','language':'rus+eng'},200)
        self.assertEqual([w['text'] for w in result['words']],['"','12.50'])
        self.assertEqual(result['text'],'"\n12.50')

    def test_native_text_is_not_replaced_and_requests_are_project_scoped(self):
        with patch('uvyazka.pdf_ocr.engine_info',return_value={'engine':'fixture','version':'1'}),patch('uvyazka.pdf_ocr.recognize') as recognize:
            result=self.service.extract('p',self.record['doc_id'],[2],'native')
            self.assertFalse(recognize.called)
        self.assertEqual(result['parser_revision'],self.record['parser_revision'])
        self.assertEqual(result['pages'][0]['status'],'native_text_available')
        self.workspace.create_project('other','Other',str(self.root));scan(self.workspace,'other')
        with self.assertRaises(ValueError):self.service.extract('other',self.record['doc_id'],[1],'native')

    def test_actual_local_tesseract_reads_a_raster_page_without_a_text_layer(self):
        try:
            engine_info('rus+eng')
            from PIL import Image,ImageDraw,ImageFont
        except (ValueError, ImportError):
            self.skipTest('Local Tesseract/Pillow unavailable')
        fonts=[Path('C:/Windows/Fonts/arial.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
        font=next((p for p in fonts if p.is_file()),None)
        if not font:self.skipTest('Test font unavailable')
        image=Image.new('RGB',(1200,600),'white');ImageDraw.Draw(image).text((80,100),'АКБ 12 Ач\nРезерв 24 часа',font=ImageFont.truetype(str(font),64),fill='black')
        data=io.BytesIO();image.save(data,format='PNG')
        import pymupdf
        with pymupdf.open() as doc:
            page=doc.new_page(width=600,height=300);page.insert_image(page.rect,stream=data.getvalue());doc.save(self.source)
        scan(self.workspace,'p');before=self.source.read_bytes()
        result=self.service.extract('p',self.record['doc_id'],[1],'actual',language='rus+eng',dpi=200)
        evidence=self.workspace.read_evidence('p',self.record['doc_id'],1)
        self.assertIn('12',evidence['text']);self.assertIn('24',evidence['text'])
        self.assertEqual(result['pages'][0]['status'],'ocr_requires_review')
        self.assertEqual(self.source.read_bytes(),before)
