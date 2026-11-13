from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.project_structure import ProjectStructure
from uvyazka.specification_source import detect_header, project_row, read_scalar, read_specification


HEADERS = ["Поз.", "Наименование", "Тип, марка", "Код продукции", "Поставщик",
           "Ед. изме-\nрения", "Кол.", "Масса 1 ед., кг", "Примечание"]


@pytest.fixture
def project():
    with TemporaryDirectory() as folder:
        root = Path(folder)
        sources = root / "sources"
        sources.mkdir()
        workspace = Workspace(root / "state")
        workspace.create_project("p", "Synthetic", sources)
        yield sources, workspace


def catalog(workspace):
    scan(workspace, "p")
    structure = ProjectStructure(workspace, "p")
    structure.build(unit_limit=10)
    return structure, structure.catalog("tables")["items"]


def test_workbook_fields_numbers_formula_and_issue(project):
    openpyxl = pytest.importorskip("openpyxl")
    sources, workspace = project
    path = sources / "synthetic.xlsx"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "СО"
    sheet.append(HEADERS)
    sheet.append([None, "Оборудование"])
    sheet.append(["П1", "Насос", "N-12", "0012", "Завод", "Шт.", 0, None, "Резерв по примечанию"])
    sheet.append(["П2", "Крепёж", None, None, None, "компл.", "1–2"])
    sheet.append(["П3", "Труба", None, None, None, "м", "=1+2"])
    sheet.append([None, "Итого", None, None, None, "м", 10])
    sheet.append([])
    reordered = HEADERS[:5] + [HEADERS[6], HEADERS[5], *HEADERS[7:]]
    sheet.append(reordered)
    sheet.append(["П4", "Кабель", None, None, None, "1,84", "м"])
    issue = workbook.create_sheet("Реквизиты")
    issue.append(["Обозначение", "Наименование", "Стадия", "Изм.", "Версия", "ДатаИзм", "№ док."])
    issue.append(["DEMO-ОВ.СО", "Спецификация оборудования", "Р", 3, "02", "08.26", "123-26"])
    workbook.save(path)
    workbook.close()

    structure, tables = catalog(workspace)
    key = next(table["table_id"] for table in tables if table["unit_name"] == "СО")
    result = read_specification(structure, key, limit=5)
    assert result["row_count"] == 9
    assert result["next_offset"] == 5
    assert [row["kind"] for row in result["rows"]] == [
        "header", "section_heading", "position_candidate", "position_candidate", "position_candidate"]
    zero, interval, formula = (item["fields"] for item in result["rows"][2:])
    assert zero["quantity"]["value"] == "0"
    assert zero["unit"]["canonical"] == "piece"
    assert zero["product_code"]["raw"] == "0012"
    assert zero["quantity"]["locator"]["cell"] == "G3"
    assert interval["quantity"]["value_status"] == "range_or_tolerance"
    assert interval["unit"]["canonical"] == "set"
    assert formula["quantity"]["value_status"] == "formula_without_cache"
    assert formula["quantity"]["value"] is None
    assert formula["quantity"]["formula"] == "=1+2"
    issue, = result["issue_candidates"]
    assert issue["fields"]["document_version"]["raw"] == "02"
    assert issue["fields"]["change_date"]["raw"] == "08.26"
    assert issue["fields"]["change_document"]["locator"]["cell"] == "G2"
    tail = read_specification(structure, key, offset=5)
    assert [row["kind"] for row in tail["rows"]] == ["subtotal", "blank", "header", "position_candidate"]
    assert tail["rows"][-1]["fields"]["quantity"]["value"] == "1.84"
    assert tail["rows"][-1]["fields"]["quantity"]["locator"]["cell"] == "F9"
    assert tail["next_offset"] is None
    path.write_bytes(path.read_bytes() + b"updated")
    assert not read_specification(structure, key)["current_registered_version"]


def test_word_slot_geometry_and_formula_cache_are_preserved():
    def slots(values, columns, row):
        return [dict(text=value, column=column, row=row, cell_id=f"{row}-{column}", locator={},
                     state="value" if value else "empty") for value, column in zip(values, columns)]

    header = detect_header(slots(HEADERS, [1, 2, 4, 5, 8, 9, 10, 12, 14], 1), word=True)
    body = slots(["1", "Радиатор", "R22", "", "Изготовитель", "шт.", "163", "", ""],
                 [1, 2, 3, 6, 7, 9, 11, 13, 15], 2)
    fields = project_row(body, header, word=True)["fields"]
    assert fields["type_mark"]["cell_id"] == "2-3"
    assert fields["quantity"]["cell_id"] == "2-11"
    assert fields["quantity"]["value"] == "163"
    assert project_row(body[:-1], header, word=True)["kind"] == "unresolved_word_layout"
    literal = {**body[6], "state": "formula", "text": "=1+2", "formula": "=1+2", "cached_value": "3"}
    assert read_scalar(literal)["cached_value"] == "3"
    assert read_scalar(literal)["value"] is None
    for date_type in ("d", 3):
        date = read_scalar({**body[6], "value_type": date_type, "text": "46104", "number_format": "dd.mm.yyyy"})
        assert date["value"] is None
        assert date["value_status"] == "nonnumeric_cell_type"
        assert date["number_format"] == "dd.mm.yyyy"


def test_pdf_continuation_has_physical_page_and_cell_coordinates(project):
    fitz = pytest.importorskip("pymupdf")
    from test_document_tables import grid

    sources, workspace = project
    widths = [55, 105, 100, 95, 95, 100, 60, 95, 95]
    pdf_headers = [label.replace("изме-\nрения", "изм.") for label in HEADERS]
    with fitz.open() as pdf:
        for x, rows in ((20, [pdf_headers, ["A1", "Насос", "N1", "", "", "шт.", "2", "", ""]]),
                        (20, [["A2", "Фильтр", "F2", "", "", "шт.", "4", "", ""],
                              ["A3", "Труба", "", "", "", "м", "—", "", ""]]),
                        (35, [["A4", "Клапан", "", "", "", "шт.", "1", "", ""]])):
            page = pdf.new_page(width=900, height=500)
            page.insert_font(fontname="fixture", fontbuffer=fitz.Font("cjk").buffer)
            grid(page, x, 35, rows, widths, height=35)
        pdf.save(sources / "synthetic.pdf")
    structure, tables = catalog(workspace)
    header, body, shifted = (table["table_id"] for table in tables)
    unresolved = read_specification(structure, body)
    assert unresolved["status"] == "header_unresolved"
    assert unresolved["rows"][0]["kind"] == "unresolved_header"
    result = read_specification(structure, body, header_table_id=header)
    assert result["source"]["page_number"] == 2
    assert len(result["rows"]) == 2
    quantity = result["rows"][0]["fields"]["quantity"]
    assert quantity["value"] == "4"
    assert quantity["locator"]["pdf_page"] == 2
    assert len(quantity["locator"]["bbox"]) == 4
    assert result["rows"][1]["fields"]["quantity"]["value_status"] == "placeholder"
    assert result["header_candidates"][result["rows"][0]["header_id"]]["table_id"] == header
    misaligned = read_specification(structure, shifted, header_table_id=header)
    assert misaligned["rows"][0]["kind"] == "unresolved_pdf_layout"
