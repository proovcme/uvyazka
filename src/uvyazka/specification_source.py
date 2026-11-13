"""Addressable equipment specification candidates over the shared literal grids."""
import json
import re

from ._vendor.les_list.structure import repair_pd_rd_text
from .core import connection
from .document_tables import bounded, number
from .project_summary import number_value
from .units import canonical_unit, resolve_unit


FIELDS = {
    "position": r"поз(?:иция)?|номерпозиции",
    "name": r"наименовани[ея](?:итех(?:ническ(?:ая|ие))?характеристик[аи])?",
    "type_mark": r"типмарка.*|маркатип.*|марка(?:изделия)?|тип(?:оборудования)?",
    "product_code": r"код(?:продукции|оборудования.*|изделия.*|материала.*)",
    "supplier": r"поставщик|(?:завод)?изготовитель|производитель",
    "unit": r"ед(?:иница)?изм(?:ерения)?",
    "quantity": r"кол(?:ичество)?|колво",
    "unit_mass": r"масса(?:1|единицы|ед)\w*",
    "note": r"примечани[ея]",
}
REQUIRED = {"name", "unit", "quantity"}
SPECIFIC = {"type_mark", "product_code", "supplier", "unit_mass"}
PLACEHOLDERS = {"-", "–", "—"}
# OOXML and legacy BIFF types for dates, booleans and error values.
NON_QUANTITY_CELL_TYPES = {"d", "b", "e", 3, 4, 5}
ISSUE_LABELS = {"обозначение": "designation", "наименование": "title", "стадия": "stage",
                "изм": "change_number", "датаизм": "change_date", "датаизменения": "change_date",
                "док": "change_document", "лист": "sheet_ref", "листи": "changed_sheet", "колуч": "change_area_count",
                "учномер": "document_control_code", "версия": "document_version",
                "редакция": "document_version", "датавыпуска": "issue_date",
                "датаразраб": "designer_date", "датапров": "checker_date", "датагип": "chief_engineer_date"}
COMPACT = re.compile(r"[^0-9a-zа-я]")
HEADER_PATTERNS = {name: re.compile(pattern) for name, pattern in FIELDS.items()}


def header_text(value):
    return COMPACT.sub("", value.casefold().replace("ё", "е"))


def has_value(cell):
    return cell["state"] in {"value", "formula"} and bool(str(cell.get("text") or "").strip())


def word_slots(row):
    # Horizontal continuation cells are synthetic. Vertical continuations
    # still occupy an original physical cell and keep their unresolved value.
    return [cell for cell in row if cell.get("merge_owner", {}).get("row") != cell["row"]]


def field_ref(cell):
    ref = {**{key: cell[key] for key in ("cell_id", "locator", "state")}, "raw": cell.get("text")}
    ref.update({key: cell[key] for key in ("value_type", "number_format", "formula_status")
                if cell.get(key) not in (None, "General")})
    if cell["state"] == "formula":
        ref.update(formula=cell.get("formula"), cached_value=cell.get("cached_value"))
    return ref


def detect_header(row, word):
    slots = word_slots(row) if word else row
    fields = {}
    for slot, cell in enumerate(slots):
        if not has_value(cell) or cell["state"] == "formula" or len(cell["text"]) > 180:
            continue
        label = header_text(repair_pd_rd_text(cell["text"]))
        field = next((key for key, pattern in HEADER_PATTERNS.items() if pattern.fullmatch(label)), None)
        if field:
            if field in fields:
                return None
            fields[field] = {**field_ref(cell), "column": cell["column"], "slot": slot}
    if not (REQUIRED <= fields.keys() and SPECIFIC & fields.keys()):
        return None
    layout = [(cell["column"], cell.get("column_span", 1)) for cell in slots] if word else None
    mode = ("word_nine_cells" if word and len(slots) == len(FIELDS) and tuple(fields) == tuple(FIELDS)
            else "word_same_grid" if word else "grid_columns")
    return {"fields": fields, "mode": mode, "layout": layout}


def read_scalar(cell):
    result = field_ref(cell)
    result["value"] = None
    if cell["state"] == "formula":
        result["value_status"] = "formula_cache" if result["cached_value"] is not None else "formula_without_cache"
    elif not has_value(cell):
        result["value_status"] = "blank" if cell["state"] == "value" else cell["state"]
    elif cell.get("value_type") in NON_QUANTITY_CELL_TYPES:
        result["value_status"] = "nonnumeric_cell_type"
    elif cell["text"].strip() in PLACEHOLDERS:
        result["value_status"] = "placeholder"
    else:
        result["value"], result["value_status"] = number_value(cell["text"])
    return result


def unresolved_cell(cell):
    if cell["state"].startswith("unresolved"):
        return True
    if cell["state"] != "merged_continuation":
        return False
    owner = cell.get("merge_owner")
    if owner:
        return owner["row"] != cell["row"]
    anchor = cell.get("merge", {}).get("anchor", "")
    return not anchor or re.sub(r"^[A-Z]+", "", anchor) != str(cell["row"])


def project_row(row, header, word):
    if not any(map(has_value, row)):
        kind = "unresolved_or_merged" if any(map(unresolved_cell, row)) else "blank"
        return {"kind": kind, "fields": {}}
    if not header:
        return {"kind": "unresolved_header", "fields": {}}
    slots = word_slots(row) if word else row
    mode = header["mode"]
    if mode == "word_nine_cells" and len(slots) == len(FIELDS):
        cells = {field: slots[descriptor["slot"]] for field, descriptor in header["fields"].items()}
    elif mode == "pdf_aligned_columns":
        cells = {}
        for field, descriptor in header["fields"].items():
            bounds = descriptor["locator"].get("bbox")
            if not bounds:
                continue
            aligned = [cell for cell in slots if (box := cell["locator"].get("bbox"))
                       and abs(box[0] - bounds[0]) <= 2 and abs(box[2] - bounds[2]) <= 2]
            if len(aligned) == 1:
                cells[field] = aligned[0]
        if not REQUIRED <= cells.keys():
            return {"kind": "unresolved_pdf_layout", "fields": {}}
    elif not word or [(cell["column"], cell.get("column_span", 1)) for cell in slots] == header["layout"]:
        by_column = {cell["column"]: cell for cell in slots}
        cells = {field: by_column[descriptor["column"]] for field, descriptor in header["fields"].items()
                 if descriptor["column"] in by_column}
    else:
        return {"kind": "unresolved_word_layout", "fields": {}}
    content = {key: cell for key, cell in cells.items() if has_value(cell)}
    if not content:
        return {"kind": "unmapped_content", "fields": {}}
    if len(content) == len(cells) and all(str(cell["text"]).strip() == str(i)
                                         for i, cell in enumerate(content.values(), 1)):
        return {"kind": "column_numbers", "fields": {}}
    label = content.get("name", {}).get("text", "").strip()
    position = content.get("position", {}).get("text", "").strip()
    kind = "position_candidate"
    if re.match(r"^(?:итого|всего|подытог)(?:\W|$)", label, re.IGNORECASE):
        kind = "subtotal"
    elif label and content.keys() <= {"name", "position"} and (
            re.fullmatch(r"[IVXLCDM]+\.?", position)
            or label.casefold() in {"оборудование", "изделия", "материалы"}):
        kind = "section_heading"
    elif not label or not ({"position", "type_mark", "unit", "quantity"} & content.keys()):
        kind = "text_or_continuation" if label and len(content) == 1 else "unresolved_position"
    fields = {key: read_scalar(cell) if key in {"quantity", "unit_mass"} else field_ref(cell)
              for key, cell in cells.items()}
    if unit := fields.get("unit"):
        raw = (unit["raw"] or "").strip()
        # Case-insensitive fallback is limited to lower-case Cyrillic units.
        lower = raw.casefold().rstrip(".")
        spelling = raw if resolve_unit(raw) else lower if re.fullmatch(r"[а-яё]+[²³23]?", lower) else raw
        unit["canonical"] = canonical_unit(spelling) if resolve_unit(spelling) else None
    mapped = {cell["cell_id"] for cell in cells.values()}
    return {"kind": kind, "fields": fields, "unmapped_cell_ids": [
        cell["cell_id"] for cell in row if has_value(cell) and cell["cell_id"] not in mapped]}


def _headers(db, table_id, word):
    records = db.execute("""select row_number,payload from structure_rows where table_id=?
        and (row_number<=40 or instr(casefold(payload),'наи')>0) order by row_number""", (table_id,))
    return {record["row_number"]: header for record in records
            if (header := detect_header(json.loads(record["payload"]), word))}


def _issue_candidates(db, version_id):
    issues = []
    tables = db.execute("select table_id,payload from structure_tables where version_id=?", (version_id,))
    for table in tables:
        card = json.loads(table["payload"])
        if card["unit_kind"] != "excel_sheet":
            continue
        rows = [json.loads(row[0]) for row in db.execute(
            "select payload from structure_rows where table_id=? and row_number<=10 order by row_number",
            (table["table_id"],))]
        for index, row in enumerate(rows[:-1]):
            columns, ambiguous = {}, set()
            for cell in row:
                if has_value(cell) and (field := ISSUE_LABELS.get(header_text(cell["text"]))):
                    if field in columns:
                        ambiguous.add(field)
                    columns[field] = cell["column"]
            for field in ambiguous:
                columns.pop(field)
            if not {"designation", "title", "stage"} <= columns.keys():
                continue
            for candidate in rows[index + 1:]:
                cells = {cell["column"]: cell for cell in candidate if has_value(cell)}
                title = cells.get(columns["title"], {}).get("text", "")
                if "спецификац" not in title.casefold() or columns["designation"] not in cells:
                    continue
                fields = {key: field_ref(cells[col]) for key, col in columns.items() if col in cells}
                issues.append({"table_id": table["table_id"], "sheet": card["unit_name"],
                               "row_number": candidate[0]["row"], "fields": fields,
                               "ambiguous_fields": sorted(ambiguous)})
                if len(issues) == 20:
                    return issues
            break
    return issues


def read_specification(structure, table_id, offset=0, limit=30, header_table_id=None, verify_source=True):
    number(offset, "offset")
    number(limit, "limit", 1, 50)
    with connection(structure.path, readonly=True) as db:
        db.execute("begin")
        row = db.execute("select payload from structure_tables where table_id=?", (table_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown table in selected project")
        card = json.loads(row[0])
        unit_record = db.execute("select payload from structure_units where unit_id=?", (card["unit_id"],)).fetchone()
        unit = json.loads(unit_record[0])
        source = {**card["source"]}
        stamp = []
        if unit["physical_page"]:
            source["page_number"] = unit["index"]
            stamp = unit.get("navigation_candidates", {}).get("title_block", [])
        word = card["unit_kind"] == "word_part"
        headers = _headers(db, table_id, word)
        active = None
        if header_table_id is not None:
            record = db.execute("select payload from structure_tables where table_id=?", (header_table_id,)).fetchone()
            header_card = json.loads(record[0]) if record else {}
            compatible_fields = ("version_id", "unit_kind") if unit["physical_page"] else (
                "version_id", "unit_kind", "column_count")
            if header_table_id == table_id or any(header_card.get(key) != card[key] for key in compatible_fields):
                raise ValueError("Continuation header requires a separate, compatible table from the same source snapshot")
            candidates = _headers(db, header_table_id, word)
            if len(candidates) != 1:
                raise ValueError("Select a continuation table with one recognized header")
            header_row, header = next(iter(candidates.items()))
            if unit["physical_page"]:
                header = {**header, "mode": "pdf_aligned_columns"}
            active = (header_table_id, header_row, header)
        for row_number, header in headers.items():
            if row_number > offset:
                break
            active = (table_id, row_number, header)
        rows, used = [], {}
        for record in db.execute("""select row_number,payload from structure_rows where table_id=?
                                    and row_number>? order by row_number limit ?""", (table_id, offset, limit)):
            row_number = record["row_number"]
            if row_number in headers:
                active = (table_id, row_number, headers[row_number])
                item = {"kind": "header", "fields": {}}
            else:
                item = project_row(json.loads(record["payload"]), active[2] if active else None, word)
            if active:
                header_id = f"{active[0]}:{active[1]}"
                item["header_id"] = header_id
                used[header_id] = {"table_id": active[0], "row_number": active[1],
                                   **{key: active[2][key] for key in ("fields", "mode")}}
            rows.append({"row_number": row_number, **item})
        issues = _issue_candidates(db, card["version_id"]) if card["unit_kind"] == "excel_sheet" else []
    freshness, current = structure.table_freshness(card, verify_source)
    return bounded({"project_id": structure.project_id, "table_id": table_id, "source": source,
                    "source_reader": card["engine"], "source_freshness": freshness, "current_registered_version": current,
                    "status": "header_candidate" if headers or header_table_id else "header_unresolved",
                    "header_candidates": used, "issue_candidates": issues, "page_stamp_candidates": stamp, "rows": rows,
                    "row_count": card["row_count"], "next_offset": offset + len(rows)
                    if offset + len(rows) < card["row_count"] else None, "accepted": False})
