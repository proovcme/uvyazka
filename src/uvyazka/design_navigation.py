"""Conservative navigation hints for Russian project and working documents."""
from datetime import date
from pathlib import PurePosixPath
import re

from ._vendor.les_list.structure import repair_pd_rd_text
from ._vendor.les_list.text_repair import normalize_cipher

STAGES = {"ПД": "П", "РД": "Р", "РКД": "Р"}
STAGE_LABEL = re.compile(r"\b(проектная|рабочая(?:\s+конструкторская)?)\s+документация\b", re.IGNORECASE)
MARKS = frozenset("""
    ПЗ ПЗУ АР КР АС КЖ КМ КМД ГП ИОС ОВ ОВиК ВК НВ НК НВК ТС ТМ
    ЭС ЭО ЭМ ЭОМ ЭН СС СКС ТХ АТХ АОВ АВК АПС СПС СОУЭ АУПТ АУВПТ АУГПТ
    ПТ ПБ МПБ ПОС ООС ОДИ ТБЭ СМ ПОД ГС ГСВ ГСН ПВ
""".upper().split())
ROLES = {
    "project_composition": r"состав\s+(?:проект(?:а|ной\s+документации)|рабочей\s+документации)",
    "volume_contents": r"содержание\s+(?:тома|книги)(?:\s+[\d.]+)?",
    "working_drawings_register": r"ведомость\s+(?:рабочих\s+чертежей|документов)\b",
    "referenced_documents": r"ведомость\s+ссылочных\s+и\s+прилагаемых\s+документов",
    "general_data": r"общие\s+данные",
    "explanatory_note": r"пояснительная\s+записка",
    "quantity_schedule": r"ведомость\s+объ[её]мов\s+(?:строительных\s+)?работ",
    "specification": r"спецификация\s+(?:оборудования|изделий|материалов)",
    "estimate": r"локальн(?:ый\s+сметный\s+расч[её]т|ая\s+смета)",
    "room_schedule": r"экспликация\s+помещений",
    "drawing": r"(?:план|схема|разрез|фасад|узел)\b",
}
SUFFIX_ROLES = {"ВОР": "quantity_schedule", "СО": "specification", "ЛСР": "estimate",
                "СП": "project_composition", "СТ": "contents_register"}
TITLE_BLOCK_PROFILE = "spds-corner-v2"
TOKEN = re.compile(r"(?<!\w)([А-ЯЁA-Z]{2,6})(\d{0,3})(?!\w)")
DESIGNATION = re.compile(r"(?=.*\d)[А-ЯЁA-Z0-9]+(?:[./_-][А-ЯЁA-Z0-9]+)*[-–—][А-ЯЁA-Z]{2,}[0-9]*(?:[.\-/][А-ЯЁA-Z0-9]+)*")
ROLE_PATTERNS = {key: re.compile(r"^" + pattern, re.IGNORECASE) for key, pattern in ROLES.items()}
DATE_TOKEN = r"(?:\d{4}[-.]\d{2}[-.]\d{2}|(?:\d{2}\.)?\d{2}\.(?:\d{2}|\d{4}))"
VERSION_TOKEN = r"[A-ZА-ЯЁ]?\d{1,6}(?:[.\-]\d{1,6}){0,3}[A-ZА-ЯЁ]?"
NAMED_VERSION = re.compile(r"\b(?:версия|редакция|ревизия|rev)[_\s.:№-]*(" + VERSION_TOKEN + r")(?!\w)", re.IGNORECASE)
NAMED_CHANGE = re.compile(r"\b(?:изм\.?|изменение)[_\s.:№-]*(\d{1,3})(?!\w)", re.IGNORECASE)
NAMED_DATE = re.compile(r"^дата\s+(?:выпуска|документа)\s*[:№-]?\s*(" + DATE_TOKEN + r")\s*$", re.IGNORECASE)
FILENAME_DATE = re.compile(r"(?<![\w.])(?:\d{4}[-.]\d{2}[-.]\d{2}|\d{2}\.\d{2}\.\d{4})(?![\w.])")
CHANGE_ACTIONS = {"зам": "replace", "нов": "new", "аннул": "cancel"}


def _candidate(field, raw, value, **location):
    return {"field": field, "raw": raw, "value": value, **location}


def _date_candidate(candidate):
    raw = candidate["value"]
    parts = raw.split(".")
    try:
        if "-" in raw:
            parsed = date.fromisoformat(raw)
        elif len(parts) == 3 and len(parts[-1]) == 4:
            day, month, year = map(int, parts)
            parsed = date(year, month, day)
        elif len(parts) == 3 and len(parts[0]) == 4:
            parsed = date(*map(int, parts))
        elif len(parts) == 2 and len(parts[-1]) == 4:
            month, year = map(int, parts)
            parsed = date(year, month, 1)
            return {**candidate, "normalized_iso": parsed.isoformat()[:7], "date_precision": "month"}
        else:
            return {**candidate, "date_precision": "unresolved_short_format"}
    except ValueError:
        return {**candidate, "date_precision": "invalid_calendar_value"}
    return {**candidate, "normalized_iso": parsed.isoformat(), "date_precision": "day"}


def path_hints(relative_path):
    """Folder and file conventions are leads, independent of the declared stamp."""
    path = PurePosixPath(relative_path.replace("\\", "/"))
    hints = []
    for index, component in enumerate(path.parts):
        name = path.stem if index == len(path.parts) - 1 else component
        location = {"source_kind": "filename" if index == len(path.parts) - 1 else "folder",
                    "component": component}
        cipher = normalize_cipher(name)
        if not re.search(r"\s", name) and DESIGNATION.fullmatch(cipher):
            hints.append(_candidate("designation", name, cipher, **location))
        delimited = name.replace("_", " ")
        for match in STAGE_LABEL.finditer(delimited):
            hints.append(_candidate("stage", match[0], "П" if match[1].casefold() == "проектная" else "Р", **location))
        for token, suffix in TOKEN.findall(delimited):
            if token in STAGES and not suffix:
                hints.append(_candidate("stage", token, STAGES[token], **location))
            if token in MARKS:
                hints.append(_candidate("mark", token + suffix, token + suffix, mark_family=token, **location))
            if token in SUFFIX_ROLES and not suffix:
                hints.append(_candidate("role", token, SUFFIX_ROLES[token], **location))
        for role, pattern in ROLE_PATTERNS.items():
            if match := pattern.match(name):
                hints.append(_candidate("role", match[0], role, **location))
        for field, pattern in (("document_version", NAMED_VERSION), ("change_number", NAMED_CHANGE)):
            for match in pattern.finditer(delimited):
                hints.append(_candidate(field, match[0], match[1], **location))
        if location["source_kind"] == "filename":
            for match in FILENAME_DATE.finditer(delimited):
                hints.append(_date_candidate(_candidate("filename_date", match[0], match[0], **location)))
    return hints


def text_hints(text):
    """Recognize headings only; do not infer a document's role from mentions in prose."""
    candidates = []
    for index, raw in enumerate(text.splitlines()[:40], 1):
        line = " ".join(repair_pd_rd_text(raw).split())
        if not line or len(line) > 110:
            continue
        for role, pattern in ROLE_PATTERNS.items():
            if pattern.match(line):
                candidates.append(_candidate("role", raw.strip(), role, source_kind="literal_line", line=index))
                break
        if match := STAGE_LABEL.fullmatch(line):
            stage = "П" if match[1].casefold() == "проектная" else "Р"
            candidates.append(_candidate("stage", raw.strip(), stage, source_kind="literal_line", line=index))
        for field, pattern in (("document_version", NAMED_VERSION), ("change_number", NAMED_CHANGE),
                               ("document_date", NAMED_DATE)):
            match = pattern.match(raw.strip())
            if match:
                candidate = _candidate(field, match[0], match[1], source_kind="literal_line", line=index)
                candidates.append(_date_candidate(candidate) if field == "document_date" else candidate)
    return candidates


def title_block_hints(page):
    """Find SPDS-like fields near a visible change table; boxes use native PDF points."""
    import pymupdf

    pt = 72 / 25.4
    right, bottom = page.rect.x1, page.rect.y1
    corner = pymupdf.Rect(max(0, right - 230 * pt), max(0, bottom - 85 * pt), right, bottom)
    words = []
    for x0, y0, x1, y1, raw, *_ in page.get_text("words", clip=corner * page.derotation_matrix):
        box = pymupdf.Rect(x0, y0, x1, y1)
        displayed = box * page.rotation_matrix
        words.append((raw, box, (displayed.x0 + displayed.x1) / 2, (displayed.y0 + displayed.y1) / 2))

    def label_text(word):
        return repair_pd_rd_text(word[0]).strip(".:").casefold()

    def labelled(label):
        return [word for word in words if label_text(word) == label]

    def emit(field, word, value, **extra):
        return _candidate(field, word[0], value, source_kind="pdf_title_block",
                          bbox=[round(coord, 3) for coord in word[1]], **extra)

    def same_row(x, y, width, pattern):
        matches = [word for word in words if abs(word[2] - x) <= width * pt
                   and abs(word[3] - y) <= 2 * pt and re.fullmatch(pattern, word[0], re.IGNORECASE)]
        return matches[0] if len(matches) == 1 else None

    dates = labelled("дата")
    rows = [(change, date) for change in labelled("изм") for date in dates
            if 25 * pt <= date[2] - change[2] <= 85 * pt and abs(date[3] - change[3]) <= 2 * pt]
    if len(rows) != 1:
        return []
    change, date_header = rows[0]
    hints, designations = [], []
    for word in words:
        code = normalize_cipher(repair_pd_rd_text(word[0]))
        if (word[2] > date_header[2] + 8 * pt and 0 <= change[3] - word[3] <= 28 * pt
                and DESIGNATION.fullmatch(code)):
            hints.append(emit("designation", word, code))
            designations.append(word)

    document_labels = [word for word in words if label_text(word) in {"№док", "nдок", "док"}
                       and change[2] < word[2] < date_header[2] and abs(word[3] - change[3]) <= 2 * pt]
    sheet_labels = [word for word in labelled("лист")
                    if change[2] < word[2] < date_header[2] and abs(word[3] - change[3]) <= 2 * pt]
    change_values = sorted((word for word in words if abs(word[2] - change[2]) <= 5 * pt
                            and 2 * pt <= change[3] - word[3] <= 24 * pt
                            and re.fullmatch(r"\d{1,3}", word[0])), key=lambda word: -word[3])
    for number in change_values[:4]:
        fields = []
        if stamp_date := same_row(date_header[2], number[3], 7, DATE_TOKEN):
            fields.append(_date_candidate(emit("change_date", stamp_date, stamp_date[0])))
        if len(document_labels) == 1:
            if doc := same_row(document_labels[0][2], number[3], 5, r"(?=.*\d)[А-ЯЁA-Z0-9]+(?:[./-][А-ЯЁA-Z0-9]+)*"):
                fields.append(emit("change_document", doc, doc[0]))
        if len(sheet_labels) == 1:
            if cell := same_row(sheet_labels[0][2], number[3], 5, r"зам\.?|нов\.?|аннул\.?|\d{1,4}"):
                action = CHANGE_ACTIONS.get(label_text(cell))
                fields.append(emit("change_action" if action else "change_sheet", cell, action or cell[0]))
        if fields or change[3] - number[3] <= 9 * pt:
            row_index = 1 + sum(hint["field"] == "change_number" for hint in hints)
            hints.append(emit("change_number", number, number[0], change_row=row_index))
            hints.extend({**field, "change_row": row_index} for field in fields)

    for role, names in (("designer", {"разраб", "разработал"}), ("checker", {"проверил"}),
                        ("norm_control", {"н.контр", "контр"}), ("chief_engineer", {"гип"})):
        for word in words:
            if label_text(word) in names and abs(word[2] - change[2]) <= 12 * pt and word[3] > change[3]:
                if stamp_date := same_row(date_header[2], word[3], 7, DATE_TOKEN):
                    hints.append(_date_candidate(emit("signature_date", stamp_date, stamp_date[0], role=role)))

    explicit_versions = []
    for word in words:
        if label_text(word) in {"версия", "ревизия", "редакция"} and word[2] > date_header[2]:
            values = [item for item in words if re.fullmatch(VERSION_TOKEN, item[0], re.IGNORECASE)
                      and ((2 * pt <= item[2] - word[2] <= 22 * pt and abs(item[3] - word[3]) <= 2 * pt)
                           or (abs(item[2] - word[2]) <= 6 * pt and 2 * pt <= item[3] - word[3] <= 8 * pt))]
            if len(values) == 1:
                explicit_versions.append(emit("document_version", values[0], values[0][0]))
    hints.extend(explicit_versions)
    if not explicit_versions and len(designations) == 1:
        cipher = designations[0]
        if (code := same_row(right - 15 * pt, cipher[3], 8, r"\d{1,3}")) and code[2] - cipher[2] > 25 * pt:
            hints.append(emit("unlabelled_stamp_code", code, code[0]))

    # Only values below their own field labels are eligible. The 'Лист' column
    # of the change table is to the left and must not be used for sheet numbering.
    for label, field, value_pattern, width in (
        ("стадия", "stage", r"П|Р|ОИ|И", 6),
        ("лист", "sheet_number", r"\d{1,4}(?:[.\-]\d{1,3})?", 6),
        ("листов", "sheet_count", r"\d{1,4}", 8),
    ):
        labels = [word for word in labelled(label)
                  if word[2] > date_header[2] + 10 * pt and abs(word[3] - change[3]) <= 18 * pt]
        if len(labels) != 1:
            continue
        _, _, x, y = labels[0]
        values = [(word, repair_pd_rd_text(word[0]).upper()) for word in words
                  if abs(word[2] - x) <= width * pt and 2 * pt <= word[3] - y <= 10 * pt]
        matching = [(word, value) for word, value in values if re.fullmatch(value_pattern, value)]
        if len(matching) == 1:
            hints.append(emit(field, *matching[0]))
    return hints[:50]
