"""Small model-facing interface to the selectively reused LIST reader."""
from .document_tables import DocumentTables


def register_tools(mcp, workspace):
    read = {"readOnlyHint": True, "idempotentHint": True}

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True})
    def index_document_tables(project_id: str, doc_id: str, sha256: str,
                              start_page: int = 1, page_limit: int = 5, refresh: bool = False) -> dict:
        """Index 1–10 pages of a registered PDF into the project database: separate tables and
        candidate volume contents/project composition/TOC. LIST heuristics are navigation, not accepted facts.
        Same byte snapshot is hashed and parsed; no OCR, automatic merging or source writes.
        Resume with next_page and get_document_structure coverage. Warnings mean unresolved coverage.
        refresh retries/replaces this page range's derived catalogue; observations stay unchanged."""
        return DocumentTables(workspace, project_id).index(doc_id, sha256, start_page, page_limit, refresh)

    @mcp.tool(annotations=read)
    def find_project_tables(project_id: str, query: str = "", doc_id: str | None = None,
                            offset: int = 0, limit: int = 40) -> dict:
        """Search cached table cells/types with pagination. Includes unknown and service tables;
        never treats search snippets or heuristic classifications as evidence. Index PDFs first.
        Actual source bytes are verified only by read_project_table; use it before quantities/comparisons."""
        return DocumentTables(workspace, project_id).find(query, doc_id, offset, limit)

    @mcp.tool(annotations=read)
    def get_document_structure(project_id: str, doc_id: str, sha256: str, section: str = "pages",
                                offset: int = 0, limit: int = 40) -> dict:
        """Resume indexed document navigation: pages|volume_contents|project_composition|pz_toc.
        Returns candidate entries, indexing coverage and next missing page. A printed target_sheet is
        not a verified PDF page number. Cached navigation is not source evidence or engineering review."""
        return DocumentTables(workspace, project_id).structure(doc_id, sha256, section, offset, limit)

    @mcp.tool(annotations=read)
    def read_project_table(project_id: str, table_id: str, offset: int = 0, limit: int = 40,
                            column_offset: int = 0, column_limit: int = 40) -> dict:
        """Read exact PDF table cells from a verified byte snapshot; check engine, geometry and matrix hash.
        Rows/columns paginate independently, including beyond row 500. Offsets are zero-based; returned
        row/column numbers are one-based and include headers/blank rows. Each cell includes a PDF bbox.
        Raw cells are evidence; normalization candidates and their units require model review.
        No automatic entity matching, table merging, approval or creation of project facts.
        Render source with render_drawing_measurements in the same unrotated coordinate frame."""
        return DocumentTables(workspace, project_id).read(table_id, offset, limit, column_offset, column_limit)
