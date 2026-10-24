from pathlib import Path
import tempfile
import unittest

from uvyazka.readers import read_blocks


class ReaderTests(unittest.TestCase):
    def test_multiline_csv_and_zero(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sample.csv"
            path.write_text('name;value\n"Two\nlines";0\n', encoding="utf-8")
            result = read_blocks(path)
            self.assertEqual(result[1]["locator"]["cells"], ["Two\nlines", "0"])

    def test_excel_literal_cells_formula_and_original(self):
        try:
            from openpyxl import Workbook
        except ImportError:
            self.skipTest("readers extra not installed")
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sample.xlsx"
            book = Workbook(); sheet = book.active; sheet.title = "Состав"
            sheet["A1"] = 0; sheet["B1"] = False; sheet["D1"] = "=A1+2"; sheet["A2"] = "3,4"
            book.save(path); book.close(); before = path.read_bytes()
            blocks = read_blocks(path)
            cells = blocks[0]["locator"]["cells"]
            self.assertEqual([c["cell"] for c in cells], ["A1", "B1", "D1"])
            self.assertEqual(cells[0]["value"], "0"); self.assertEqual(cells[1]["value"], "False")
            self.assertTrue(cells[2]["needs_recalculation"])
            self.assertEqual(path.read_bytes(), before)

    def test_pdf_page_locator(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest("readers extra not installed")
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sample.pdf"
            with pymupdf.open() as doc:
                doc.new_page().insert_text((30, 40), "Synthetic 3.4 m2")
                doc.save(path)
            block = read_blocks(path)[0]
            self.assertEqual(block["locator"], {"kind": "pdf_page", "pdf_page": 1})
            self.assertIn("3.4", block["text"])

    def test_excel_empty_first_cell_and_missing_rows_keep_real_addresses(self):
        from openpyxl import Workbook
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'sparse.xlsx';book=Workbook();sheet=book.active
            sheet['D1']='Наименование';sheet['K1']='Кол-во';sheet['D4']='Насос';sheet['K4']=0
            book.save(path);book.close()
            blocks=read_blocks(path)
            self.assertEqual([b['locator']['row'] for b in blocks],[1,4])
            self.assertEqual(blocks[1]['locator']['cells'][1]['cell'],'K4')
            self.assertEqual(blocks[1]['locator']['cells'][1]['value'],'0')


if __name__ == "__main__":
    unittest.main()
