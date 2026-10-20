"""Synthetic PDF evidence, LIST candidates, source boundaries and resumable reading."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from uvyazka.core import Workspace, connection
from uvyazka.ingest import scan
from uvyazka.document_tables import DocumentTables, navigation
from uvyazka._vendor.les_list import tables

try:
    import pymupdf
except ImportError:
    pymupdf = None


def grid(page, x, y, matrix, widths, height=22):
    right = x+sum(widths); bottom = y+len(matrix)*height
    for column in range(len(widths)+1):
        left = x+sum(widths[:column]); page.draw_line((left,y),(left,bottom))
    for row in range(len(matrix)+1):
        top = y+row*height; page.draw_line((x,top),(right,top))
    for row, values in enumerate(matrix):
        for column, value in enumerate(values):
            if value is not None:
                page.insert_text((x+sum(widths[:column])+4,y+(row+1)*height-6),str(value),fontname="fixture",fontsize=8)


@unittest.skipIf(pymupdf is None, "readers extra not installed")
class DocumentTableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.sources = self.root/"sources"; self.sources.mkdir()
        self.file = self.sources/"synthetic.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page(width=700,height=500)
            page.insert_font(fontname="fixture",fontbuffer=pymupdf.Font("cjk").buffer)
            matrix = [["Номер помещения","Наименование","Площадь, м2"], ["101","Офис","12,5"], ["102","Склад","10–20"]]
            grid(page,30,60,matrix,[95,90,95]); grid(page,370,60,matrix,[95,90,95])
            page.set_cropbox(pymupdf.Rect(20,20,680,480)); page.set_rotation(90)
            page = pdf.new_page(width=500,height=500)
            page.insert_font(fontname="fixture",fontbuffer=pymupdf.Font("cjk").buffer)
            page.insert_text((30,40),"Состав проекта\nНомер тома\nОбозначение\nНаименование\nПримечание\n1\nTEST-2026-АР\nАрхитектурные решения",fontname="fixture",fontsize=10)
            pdf.new_page(width=200,height=200)
            pdf.save(self.file)
        self.original = self.file.read_bytes()
        self.workspace = Workspace(self.root/"state")
        self.workspace.create_project("a","Synthetic",self.sources); scan(self.workspace,"a")
        doc = self.workspace.find_documents("a")["documents"][0]
        self.doc_id, self.sha = doc["doc_id"],doc["sha256"]
        self.store = DocumentTables(self.workspace,"a")

    def tearDown(self): self.temp.cleanup()

    def test_two_equal_headers_stay_separate_and_raw_ranges_survive(self):
        index = self.store.index(self.doc_id,self.sha,page_limit=1)
        self.assertEqual(index["next_page"],2)
        self.assertEqual(index["pages"][0]["catalogued_tables"],2)
        cards = self.store.find()["items"]
        self.assertNotEqual(cards[0]["table_id"],cards[1]["table_id"])
        self.assertEqual(cards[0]["coordinate_system"],"pdf_unrotated_top_left_points")
        read = self.store.read(cards[0]["table_id"])
        self.assertTrue(read["is_evidence"])
        self.assertEqual(read["rows"][1]["cells"][2]["text"],"12,5")
        self.assertEqual(read["rows"][2]["cells"][2]["text"],"10–20")
        self.assertEqual(read["normalization_candidates"][0]["area_m2"],12.5)
        self.assertIsNone(read["normalization_candidates"][1]["area_m2"])
        self.assertEqual(read["rows"][0]["cells"][0]["bbox"][0],10)
        self.assertEqual(self.store.find("Склад")["total"],2)
        self.assertEqual(self.file.read_bytes(),self.original)
        with connection(self.workspace.db_path("a"),readonly=True) as db:
            self.assertEqual(db.execute("select count(*) from facts").fetchone()[0],0)

    def test_resume_coverage_navigation_and_cache(self):
        self.store.index(self.doc_id,self.sha,page_limit=1)
        reopened = DocumentTables(Workspace(self.workspace.home),"a")
        coverage = reopened.structure(self.doc_id,self.sha)["coverage"]
        self.assertEqual((coverage["indexed_pages"],coverage["next_unindexed_page"]),(1,2))
        with patch("uvyazka.document_tables.detect",side_effect=AssertionError("cached page must not reparse")):
            reopened.index(self.doc_id,self.sha,page_limit=1)
        reopened.index(self.doc_id,self.sha,start_page=2,page_limit=2)
        info = reopened.structure(self.doc_id,self.sha)
        self.assertEqual(info["coverage"]["indexed_pages"],3)
        self.assertIsNone(info["coverage"]["next_unindexed_page"])
        self.assertIsNone(info["coverage"]["reviewed_pages"])
        self.assertEqual(info["coverage"]["pages_with_warnings"],1)
        composition = reopened.structure(self.doc_id,self.sha,"project_composition")["items"]
        self.assertEqual(composition[0]["designation"],"TEST-2026-АР")
        self.assertEqual(composition[0]["source"]["page_number"],2)
        self.assertFalse(composition[0]["is_evidence"])

    def test_mtime_is_not_content_but_changed_source_and_engine_refuse(self):
        self.store.index(self.doc_id,self.sha,page_limit=1)
        table = self.store.find()["items"][0]["table_id"]
        st = self.file.stat(); os.utime(self.file,ns=(st.st_atime_ns,st.st_mtime_ns+10000000))
        self.assertTrue(self.store.read(table)["is_evidence"])
        with patch("uvyazka.document_tables.engine",return_value="changed"):
            with self.assertRaisesRegex(ValueError,"Detector/algorithm"):
                self.store.read(table)
        self.file.write_bytes(self.original+b"\n% new source")
        self.assertFalse(self.store.find()["is_evidence"])
        with self.assertRaisesRegex(ValueError,"Source changed"):
            self.store.read(table)
        scan(self.workspace,"a")
        self.assertEqual(self.store.find()["total"],0)
        self.assertEqual(self.store.structure(self.doc_id,self.sha)["freshness"],"registered_version_changed")

    def test_rows_after_500_and_column_windows(self):
        path = self.sources/"long.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page(width=250,height=9000)
            page.insert_font(fontname="fixture",fontbuffer=pymupdf.Font("cjk").buffer)
            grid(page,10,20,[["ID","Value"]]+[[str(i),str(i*2)] for i in range(1,601)],[80,120],height=14)
            pdf.save(path)
        scan(self.workspace,"a")
        doc = next(d for d in self.workspace.find_documents("a")["documents"] if d["relative_path"]=="long.pdf")
        self.store.index(doc["doc_id"],doc["sha256"])
        key = self.store.find(doc_id=doc["doc_id"])["items"][0]["table_id"]
        result = self.store.read(key,offset=500,limit=100,column_limit=1)
        self.assertEqual(result["row_count"],601)
        self.assertEqual(result["rows"][0]["row_number"],501)
        self.assertEqual(result["rows"][0]["cells"][0]["text"],"500")
        self.assertEqual(result["next_offset"],600)
        self.assertEqual(result["next_column_offset"],1)
        tail = self.store.read(key,offset=600,column_offset=1,column_limit=1)
        self.assertEqual(tail["rows"][0]["cells"][0]["text"],"1200")
        self.assertIsNone(tail["next_offset"])
        self.assertIsNone(tail["next_column_offset"])

    def test_project_boundaries_invalid_arguments_and_heavy_page(self):
        self.store.index(self.doc_id,self.sha,page_limit=1)
        key = self.store.find()["items"][0]["table_id"]
        self.workspace.create_project("b","Other",self.sources)
        other = DocumentTables(self.workspace,"b")
        self.assertEqual(other.find()["items"],[])
        with self.assertRaises(ValueError): other.read(key)
        for args in [{"offset":-1},{"limit":101},{"column_offset":True}]:
            with self.assertRaises(ValueError): self.store.read(key,**args)
        with self.assertRaises(ValueError): self.store.index(self.doc_id,self.sha,page_limit=11)
        with patch("uvyazka.document_tables.detect",side_effect=ValueError("heavy_page")):
            data = self.store.index(self.doc_id,self.sha,start_page=2,page_limit=1)
        self.assertEqual(data["pages"][0]["status"],"partial")
        self.assertIn("heavy_page",data["pages"][0]["warnings"][0])
        retry = self.store.index(self.doc_id,self.sha,start_page=2,page_limit=1,refresh=True)
        self.assertEqual(retry["pages"][0]["status"],"indexed_not_reviewed")


class ListHeuristicTests(unittest.TestCase):
    def test_hvac_water_and_service_candidates_keep_units_and_missing_values(self):
        hvac = tables.normalize_hvs_table([
            ["Система","Расход воздуха, м3/ч","Давление, Па","Тепловая мощность, кВт"],
            ["П7","1 500","250–400","0"]],source_ref="table:hvac")
        row = hvac["rows"][0]
        self.assertEqual(row["airflow_m3h"],1500)
        self.assertIsNone(row["pressure_pa"])
        self.assertEqual(row["heat_load_kw"],0)
        water = tables.normalize_water_balance_table([
            ["Потребитель","Холодная вода, м3/сут","Горячая вода, м3/сут","Водоотведение, м3/сут"],
            ["Корпус А","2,75","—","0"]],source_ref="table:water")
        row = water["rows"][0]
        self.assertEqual(row["cold_water_m3_day"],2.75)
        self.assertIsNone(row["hot_water_m3_day"])
        self.assertEqual(row["wastewater_m3_day"],0)
        kind = tables.classify_project_table_semantic([
            ["Имя панели","Помещение"],["ЩС-7","Насосная 205"]])
        self.assertIn("CABLE_JOURNAL",kind["semantic_type"])

    def test_numeric_uncertainty_and_blank_row_addresses(self):
        for value in ["10–20","10-20","~12","12 м2","2*3","1 2","12 34","",None]:
            self.assertIsNone(tables._num(value))
        self.assertEqual(tables._num("0"),0)
        self.assertEqual(tables._num("1 200,5"),1200.5)
        result = tables.normalize_room_explication_table([
            ["Номер помещения","Наименование","Площадь, м2"],
            [None,None,None],["101","Офис","12,5"]],source_ref="table:synthetic")
        self.assertEqual(result["rows"][0]["source_ref"],"table:synthetic#row=3")

    def test_navigation_is_candidate_and_printed_sheet_is_not_pdf_address(self):
        result = navigation("Оглавление\n1 Общие данные .... 12",2)
        self.assertEqual(result["pz_toc"][0]["target_sheet"],12)
        self.assertEqual(result["pz_toc"][0]["page"],2)
