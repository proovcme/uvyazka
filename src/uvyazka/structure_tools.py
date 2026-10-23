"""The same source catalog used by the local dashboard."""
from .project_structure import ProjectStructure


def register_tools(mcp,workspace):
    read={'readOnlyHint':True,'idempotentHint':True}
    write={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':False}

    @mcp.tool(annotations=write)
    def build_project_structure(project_id: str,doc_id: str | None=None,unit_limit: int=5,document_limit: int=3,retry_failed: bool=False) -> dict:
        """Resume literal PDF pages/tables, Excel worksheets/cells, Word XML parts/tables or CSV.
        Uses registered source hashes and the shared project DB. Call scan first. Bounded batches:
        repeat until coverage.pending_documents=0; failed/unsupported sources are explicit, not errors
        in the engineering project. Formulas are NOT calculated, Word parts are NOT physical pages.
        Header/profile candidates do not approve facts. retry_failed=true retries a failed batch once;
        use false for subsequent progress calls. No model API, hidden OCR or external uploads."""
        return ProjectStructure(workspace,project_id).build(doc_id,unit_limit,document_limit,retry_failed)

    @mcp.tool(annotations=read)
    def get_project_structure(project_id: str,kind: str='sheets',query: str='',doc_id: str | None=None,offset: int=0,limit: int=40) -> dict:
        """Navigate current registered source versions: kind=sheets|tables|documents.
        Physical PDF pages, Excel sheets, logical Word parts remain distinct. Coverage reports unfinished,
        failed and unsupported documents separately. Does not parse originals or verify actual bytes."""
        return ProjectStructure(workspace,project_id).catalog(kind,query,doc_id,offset,limit)

    @mcp.tool(annotations=read)
    def read_structure_table(project_id: str,table_id: str,offset: int=0,limit: int=40,column_offset: int=0,column_limit: int=20,verify_source: bool=True) -> dict:
        """Read persisted literal cells, locators, merge owners, formula/cache and human/model readings.
        Offsets are zero-based row/column windows. Default verifies source SHA; no repeated parsing.
        Source freshness and current_registered_version must be checked before using a result.
        A parser match does not establish an accepted engineering value. Source units are not inferred."""
        return ProjectStructure(workspace,project_id).read(table_id,offset,limit,column_offset,column_limit,verify_source)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def record_structure_review(project_id: str,cell_id: str,reader: str,observed_text: str | None,state: str,
                                method: str,request_id: str,reason: str='',expected_revision: int=0) -> dict:
        """Append a human/model reading beside the immutable parser cell, never over it.
        reader=model|human; method=visual_original|native_source|cached_extraction (the last is NOT independent).
        state=value|empty|absent|formula|merged_continuation|unresolved_empty|unresolved_or_merged|unresolved_merge|question|unreadable.
        Questions/unreadable and corrections require reason. Use exact cell_id; expected_revision is 0 first,
        then the previous reading revision for that reader. Reuse request_id only for identical retries.
        Keeps history and literal/numeric match, discrepancy or stale status; never accepts facts."""
        return ProjectStructure(workspace,project_id).review(cell_id,reader,observed_text,state,method,request_id,reason,expected_revision)
