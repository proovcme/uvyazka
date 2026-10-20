"""LIST-derived navigation candidates over registered PDF snapshots, with exact reads.

No inferred fact is accepted here. Table fragments are never silently merged.
"""
import hashlib
import json
import re
import sys

from .core import connection, encode, now
from .pdf_source import open_pdf
from .measurements import COORDINATES
from ._vendor.les_list import tables as heuristics, structure

ALGORITHM = "uvyazka-list-selected-v1"
SQL = """
create table if not exists pdf_catalog_pages(
 doc_id text not null, sha256 text not null, engine text not null, page_number integer not null,
 payload text not null, primary key(doc_id,sha256,engine,page_number));
create table if not exists pdf_table_catalog(
 table_id text primary key, doc_id text not null, sha256 text not null, engine text not null,
 page_number integer not null, table_index integer not null, search_text text not null, payload text not null);
create index if not exists pdf_table_scope on pdf_table_catalog(doc_id,sha256,engine,page_number);
"""


def engine():
    try:
        import pymupdf
    except ImportError as exc:
        raise ValueError("Install uvyazka[readers] for PDF tables") from exc
    return ALGORITHM + "/pymupdf:" + pymupdf.VersionBind


def number(value, name, minimum=0, maximum=None):
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        raise ValueError("Invalid " + name)
    return value


def fingerprint(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def bounded(result):
    if len(encode(result).encode()) > 1024*1024:
        raise ValueError("Result exceeds 1 MiB; reduce row/page/column limit")
    return result


def table_matrix(table):
    if table.row_count > 20000 or table.col_count > 512 or table.row_count*table.col_count > 300000:
        raise ValueError("table_exceeds_20000_rows_512_columns_300000_cells")
    matrix = table.extract()
    # Original cells, including None, empty rows and line breaks, remain evidence.
    return matrix or []


def detect(page):
    import pymupdf
    # The optional layout recommendation uses print(), outside message routing.
    # Other reader diagnostics belong on stderr, never the MCP JSON-RPC stream.
    if hasattr(pymupdf, "no_recommend_layout"):
        pymupdf.no_recommend_layout()
    pymupdf.set_messages(stream=sys.stderr)
    if len(page.get_drawings()) > 3000:
        raise ValueError("table_detection_skipped_heavy_vector_page")
    found = page.find_tables()
    if len(found.tables) > 200:
        raise ValueError("table_detection_exceeds_200_tables_per_page")
    return found


def navigation(text, page_number):
    repaired = structure.repair_pd_rd_text(text)
    lines = [structure._clean_line(line) for line in repaired.splitlines()]
    lines = [line for line in lines if line]
    return {"volume_contents": structure._parse_volume_contents_lines(lines, page_no=page_number),
            "project_composition": structure._parse_project_composition_lines(lines, page_no=page_number)
                if structure._looks_like_project_composition_lines(lines) else [],
            "pz_toc": structure._parse_pz_toc_lines(lines, page_no=page_number)}


class DocumentTables:
    def __init__(self, workspace, project_id):
        self.workspace, self.project_id = workspace, project_id
        self.path = workspace.db_path(project_id)
        with connection(self.path) as db:
            db.executescript(SQL)

    def index(self, doc_id, sha256, start_page=1, page_limit=5, refresh=False):
        number(start_page, "start_page", 1)
        number(page_limit, "page_limit", 1, 10)
        version = engine()
        result = []
        with open_pdf(self.workspace, self.project_id, doc_id, sha256) as pdf:
            total = len(pdf)
            if start_page > total:
                raise ValueError("Page outside PDF")
            end = min(total+1, start_page+page_limit)
            for page_number in range(start_page, end):
                with connection(self.path, readonly=True) as db:
                    cached = db.execute("select payload from pdf_catalog_pages where doc_id=? and sha256=? and engine=? and page_number=?",
                                        (doc_id, sha256, version, page_number)).fetchone()
                if cached and not refresh:
                    summary = json.loads(cached[0])
                    result.append({k:v for k,v in summary.items() if k != "navigation"})
                    continue
                page = pdf[page_number-1]
                rotation = page.rotation
                page.set_rotation(0)
                source = {"doc_id": doc_id, "sha256": sha256, "page_number": page_number}
                summary = {**source, "engine": version, "page_count": total,
                           "coordinate_system": COORDINATES, "page_bounds": list(page.rect),
                           "original_rotation": rotation, "indexed_at": now(), "warnings": [], "navigation": {}}
                text = page.get_text("text")
                if len(text) > 1000000:
                    summary["warnings"].append("navigation_skipped_text_exceeds_1M_characters")
                else:
                    summary["navigation"] = navigation(text, page_number)
                if not text.strip():
                    summary["warnings"].append("no_text_layer_visual_or_OCR_read_needed")
                cards = []
                try:
                    found = detect(page)
                    summary["detected_tables"] = len(found.tables)
                    for index, table in enumerate(found.tables, 1):
                        try:
                            matrix = table_matrix(table)
                        except ValueError as exc:
                            summary["warnings"].append(f"table_{index}:"+str(exc))
                            continue
                        bbox = list(table.bbox)
                        matrix_hash = fingerprint(matrix)
                        key = fingerprint([self.project_id, doc_id, sha256, version, page_number, index, bbox, matrix_hash])[:32]
                        context = heuristics._table_context(page, table)
                        classification = heuristics.classify_project_table_semantic(matrix,
                            source_ref=f"table:{key}", context_norm=context)
                        normalizer = heuristics.classify_project_table(matrix, context_norm=context)
                        card = {"table_id": key, "source": source, "engine": version,
                                "table_index": index, "bbox": bbox, "coordinate_system": COORDINATES,
                                "row_count": len(matrix), "column_count": table.col_count,
                                "matrix_sha256": matrix_hash, "classification_candidate": classification,
                                "normalizer_candidate": normalizer, "context_candidate": context[:2000],
                                "interpretation_status": "heuristic_candidate", "is_evidence": False}
                        # No search over inferred quantities; raw source cells supply the text.
                        search = " ".join(str(cell or "") for row in matrix for cell in row)
                        cards.append((card, search))
                except Exception as exc:
                    summary["warnings"].append("table_detection_failed:"+type(exc).__name__+":"+str(exc)[:250])
                summary["catalogued_tables"] = len(cards)
                summary["status"] = "partial" if summary["warnings"] else "indexed_not_reviewed"
                with connection(self.path) as db:
                    db.execute("begin immediate")
                    # Refresh replaces only the derived catalogue, never project observations.
                    exists = db.execute("select 1 from pdf_catalog_pages where doc_id=? and sha256=? and engine=? and page_number=?",
                                        (doc_id, sha256, version, page_number)).fetchone()
                    if not exists or refresh:
                        if exists:
                            db.execute("delete from pdf_table_catalog where doc_id=? and sha256=? and engine=? and page_number=?",
                                       (doc_id, sha256, version, page_number))
                            db.execute("delete from pdf_catalog_pages where doc_id=? and sha256=? and engine=? and page_number=?",
                                       (doc_id, sha256, version, page_number))
                        for card, search in cards:
                            db.execute("insert into pdf_table_catalog values (?,?,?,?,?,?,?,?)",
                                (card["table_id"], doc_id, sha256, version, page_number, card["table_index"], search, encode(card)))
                        db.execute("insert into pdf_catalog_pages values (?,?,?,?,?)", (doc_id, sha256, version, page_number, encode(summary)))
                        db.execute("insert into events(created_at,kind,payload) values(?,?,?)", (now(), "pdf_structure_indexed", encode({**source, "engine": version})))
                result.append({k:v for k,v in summary.items() if k != "navigation"})
        return bounded({"project_id": self.project_id, "pages": result, "page_count": total,
                        "next_page": end if end <= total else None,
                        "note": "Indexing is navigation, not complete extraction or engineering review. Resume missing pages with get_document_structure."})

    def find(self, query="", doc_id=None, offset=0, limit=40):
        number(offset, "offset"); number(limit, "limit", 1, 100)
        if not isinstance(query, str) or len(query) > 500: raise ValueError("Query exceeds 500 characters")
        # Navigation can be stale before scan; exact read always verifies actual bytes.
        where = """ from pdf_table_catalog t join documents d on d.doc_id=t.doc_id
            where t.sha256=d.sha256 and t.engine=? and (? is null or t.doc_id=?)
            and instr(casefold(t.search_text || ' ' || json_extract(t.payload,'$.classification_candidate.semantic_type')),casefold(?))>0"""
        # Coalesce allows unknown/empty tables to be found too.
        where = where.replace("json_extract(t.payload,'$.classification_candidate.semantic_type')", "coalesce(json_extract(t.payload,'$.classification_candidate.semantic_type'),'')")
        args = (engine(), doc_id, doc_id, query)
        with connection(self.path, readonly=True) as db:
            total = db.execute("select count(*)"+where, args).fetchone()[0]
            items = [json.loads(r[0]) for r in db.execute("select t.payload"+where+" order by t.doc_id,t.page_number,t.table_index limit ? offset ?", (*args, limit, offset))]
        return bounded({"project_id": self.project_id, "items": items, "total": total,
                        "next_offset": offset+limit if offset+limit < total else None,
                        "is_evidence": False, "freshness": "catalog_navigation_only_actual_bytes_not_checked"})

    def structure(self, doc_id, sha256, section="pages", offset=0, limit=40):
        number(offset, "offset"); number(limit, "limit", 1, 100)
        if section not in {"pages", "volume_contents", "project_composition", "pz_toc"}:
            raise ValueError("Unknown structure section")
        record, _ = self.workspace.source_record(self.project_id, doc_id)
        with connection(self.path, readonly=True) as db:
            pages = [json.loads(r[0]) for r in db.execute("select payload from pdf_catalog_pages where doc_id=? and sha256=? and engine=? order by page_number", (doc_id, sha256, engine()))]
        total_pages = pages[0]["page_count"] if pages else None
        processed = {p["page_number"] for p in pages}
        missing = next((i for i in range(1, (total_pages or 0)+1) if i not in processed), None)
        items = []
        for page in pages:
            if section == "pages":
                items.append({k:v for k,v in page.items() if k != "navigation"})
            else:
                for entry in page["navigation"].get(section, []):
                    items.append({**entry, "source": {"doc_id": doc_id, "sha256": sha256, "page_number": page["page_number"]},
                                  "interpretation_status": "heuristic_candidate", "is_evidence": False,
                                  "target_sheet_is_not_verified_pdf_page": True})
        return bounded({"project_id": self.project_id, "doc_id": doc_id, "sha256": sha256, "section": section,
                        "items": items[offset:offset+limit], "total": len(items),
                        "next_offset": offset+limit if offset+limit < len(items) else None,
                        "coverage": {"indexed_pages": len(pages), "page_count": total_pages,
                                     "pages_with_warnings": sum(bool(p["warnings"]) for p in pages),
                                     "next_unindexed_page": missing if pages else 1,
                                     "reviewed_pages": None},
                        "freshness": "registered_version_changed" if record["sha256"] != sha256 else "catalog_navigation_only_actual_bytes_not_checked"})

    def read(self, table_id, offset=0, limit=40, column_offset=0, column_limit=40):
        number(offset, "offset"); number(limit, "limit", 1, 100)
        number(column_offset, "column_offset"); number(column_limit, "column_limit", 1, 100)
        if not isinstance(table_id, str) or not re.fullmatch(r"[0-9a-f]{32}", table_id):
            raise ValueError("Invalid table ID")
        with connection(self.path, readonly=True) as db:
            saved = db.execute("select payload from pdf_table_catalog where table_id=?", (table_id,)).fetchone()
        if not saved: raise ValueError("Unknown table in this project")
        card = json.loads(saved[0])
        if card["engine"] != engine(): raise ValueError("Detector/algorithm changed; rebuild the catalogue")
        source = card["source"]
        with open_pdf(self.workspace, self.project_id, source["doc_id"], source["sha256"]) as pdf:
            page = pdf[source["page_number"]-1]; page.set_rotation(0)
            found = detect(page)
            index = card["table_index"]-1
            if index >= len(found.tables): raise ValueError("Table detection changed; rebuild catalogue")
            table = found.tables[index]; matrix = table_matrix(table)
            if list(table.bbox) != card["bbox"] or fingerprint(matrix) != card["matrix_sha256"]:
                raise ValueError("Table geometry or cells changed; rebuild catalogue")
            selected = []
            for r in range(offset, min(offset+limit, len(matrix))):
                boxes = table.rows[r].cells
                selected.append({"row_number": r+1, "cells": [
                    {"column_number": c+1, "text": matrix[r][c], "bbox": list(boxes[c]) if boxes[c] is not None else None}
                    for c in range(column_offset, min(column_offset+column_limit, len(matrix[r])))]})
            proposed = []
            kind = card["normalizer_candidate"]["table_type"]
            normalizer = {"room_explication": heuristics.normalize_room_explication_table,
                          "hvs_air_system": heuristics.normalize_hvs_table,
                          "vk_water_balance": heuristics.normalize_water_balance_table}.get(kind)
            if normalizer and column_offset == 0 and column_limit >= table.col_count:
                normalized = normalizer(matrix, source_ref="table:"+table_id)
                for candidate in (normalized or {}).get("rows", []):
                    row_number = int(candidate["source_ref"].rsplit("=", 1)[-1])
                    if offset < row_number <= offset+limit:
                        proposed.append({**candidate, "row_number": row_number, "status": "heuristic_candidate"})
            result = {"project_id": self.project_id, "table_id": table_id, "source": source,
                      "engine": card["engine"], "bbox": card["bbox"], "coordinate_system": COORDINATES,
                      "rows": selected, "row_count": len(matrix), "column_count": table.col_count,
                      "next_offset": offset+limit if offset+limit < len(matrix) else None,
                      "next_column_offset": column_offset+column_limit if column_offset+column_limit < table.col_count else None,
                      "is_evidence": True, "evidence_scope": "raw_extracted_cells_only_not_engineering_acceptance",
                      "normalization_candidates": proposed,
                      "normalization_note": "Heuristic fields/units need model review. None is unknown, not zero. Ranges stay raw. Candidates omitted for partial columns.",
                      "coverage": "This row/column window was returned; not proof the model reviewed it. Empty/merged cells are preserved."}
        return bounded(result)
