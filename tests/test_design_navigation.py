import pytest

from uvyazka.design_navigation import path_hints, text_hints, title_block_hints


def test_path_hints_keep_context_and_do_not_infer_stage_from_mark():
    hints = path_hints("РД/ОВ/DEMO-12-ОВ.СО.pdf")
    assert any(h["field"] == "stage" and h["value"] == "Р" and h["source_kind"] == "folder" for h in hints)
    assert any(h["field"] == "designation" and h["raw"] == "DEMO-12-ОВ.СО" for h in hints)
    assert any(h["field"] == "role" and h["value"] == "specification" for h in hints)
    assert not any(h["field"] == "stage" for h in path_hints("АР/DEMO-12-АР.pdf"))
    path_metadata = {h["field"]: h for h in path_hints("РД/КЖ4/DEMO_rev02_2026.11.06.pdf")}
    assert path_metadata["mark"]["mark_family"] == "КЖ"
    assert path_metadata["mark"]["value"] == "КЖ4"
    assert path_metadata["document_version"]["value"] == "02"
    assert path_metadata["filename_date"]["normalized_iso"] == "2026-11-06"
    assert text_hints("Передана пояснительная записка") == []
    assert text_hints("Ведомость объемов строительных работ")[0]["value"] == "quantity_schedule"
    assert text_hints("Дата выпуска: 08.2026")[0]["date_precision"] == "month"


@pytest.mark.parametrize("rotation", [0, 90])
def test_stamp_fields_use_position_and_keep_sheet_count_distinct(rotation):
    fitz = pytest.importorskip("pymupdf")
    with fitz.open() as pdf:
        page = pdf.new_page(width=595, height=842)
        page.set_rotation(rotation)
        font = fitz.Font("cjk")
        page.insert_font(fontname="fixture", fontbuffer=font.buffer)
        # Coordinates are laid out in the displayed page. Write in native space.
        pt = 72 / 25.4
        words = [("Изм.", 182, 36), ("Дата", 128, 36), ("Лист", 162, 36), ("№док.", 151, 36),
                 ("2", 182, 42), ("08.26", 128, 42), ("Зам.", 162, 42), ("125-26", 151, 42),
                 ("1", 182, 48), ("04.02.2026", 128, 48), ("4", 162, 48),
                 ("Разраб.", 182, 27), ("09.2025", 128, 27),
                 ("Версия", 83, 66), ("02", 65, 66),
                 ("DEMO-12-ОВ", 71, 54), ("Стадия", 47, 31), ("Лист", 32, 31),
                 ("Листов", 16, 31), ("Р", 47, 24), ("4", 32, 24)]
        for word, x, y in words:
            center = fitz.Point(page.rect.x1 - x * pt, page.rect.y1 - y * pt)
            origin = center + (-font.text_length(word, fontsize=8) / 2, 2)
            page.insert_text(origin * page.derotation_matrix, word, fontname="fixture", fontsize=8, rotate=rotation)
        result = title_block_hints(page)
        assert {item["field"]: item["raw"] for item in result if "change_row" not in item} == {
            "designation": "DEMO-12-ОВ", "stage": "Р", "sheet_number": "4",
            "signature_date": "09.2025", "document_version": "02",
        }
        first = {h["field"]: h for h in result if h.get("change_row") == 1}
        second = {h["field"]: h for h in result if h.get("change_row") == 2}
        assert first["change_number"]["raw"] == "2"
        assert first["change_document"]["raw"] == "125-26"
        assert first["change_action"]["value"] == "replace"
        assert first["change_date"]["date_precision"] == "unresolved_short_format"
        assert "normalized_iso" not in first["change_date"]
        assert second["change_number"]["raw"] == "1"
        assert second["change_sheet"]["raw"] == "4"
        assert second["change_date"]["normalized_iso"] == "2026-02-04"
        native = fitz.Rect(next(item["bbox"] for item in result if item["field"] == "sheet_number"))
        assert 29 <= (page.rect.x1 - (native * page.rotation_matrix).x0) / pt <= 34
