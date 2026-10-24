"""The same source catalog used by the local dashboard."""
from .project_structure import ProjectStructure


def register_tools(mcp,workspace):
    read={'readOnlyHint':True,'idempotentHint':True}
    write={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':False}

    @mcp.tool(annotations=write)
    def build_project_structure(project_id: str,doc_id: str | None=None,unit_limit: int=5,document_limit: int=3,retry_failed: bool=False,start_unit: int | None=None) -> dict:
        """Resume literal PDF pages/tables, Excel worksheets/cells, Word XML parts/tables or CSV.
        Uses registered source hashes and the shared project DB. Call scan first. Bounded batches:
        repeat until scope_coverage.pending_documents=0 for the selected document scope; failed/unsupported sources are explicit, not errors
        in the engineering project. Formulas are NOT calculated, Word parts are NOT physical pages.
        Header/profile candidates do not approve facts. retry_failed=true retries a failed batch once;
        use false for subsequent progress calls. start_unit targets a 1-based PDF page, worksheet or Word part
        in one explicit doc_id; unvisited earlier units remain pending. A targeted-page task need not clear
        pending units outside that selection. No model API or external uploads."""
        return ProjectStructure(workspace,project_id).build(doc_id,unit_limit,document_limit,retry_failed,start_unit)

    @mcp.tool(annotations=read)
    def get_project_structure(project_id: str,kind: str='sheets',query: str='',doc_id: str | None=None,offset: int=0,limit: int=40,history: bool=False,analysis_id: str | None=None) -> dict:
        """Navigate current registered source versions: kind=sheets|tables|documents|analyses.
        Physical PDF pages, Excel sheets, logical Word parts remain distinct. Coverage reports unfinished,
        failed and unsupported documents separately. Analyses keeps caller interpretations, links, questions;
        history=true includes old analysis revisions. Navigation does not parse originals or verify bytes.
        With kind=analyses and exact analysis_id, return the two latest reader lanes with actual SHA checks."""
        if analysis_id is not None:
            if kind!='analyses':raise ValueError('analysis_id requires kind=analyses')
            from .structure_analysis import StructureAnalysis
            return StructureAnalysis(workspace,project_id).read(analysis_id)
        return ProjectStructure(workspace,project_id).catalog(kind,query,doc_id,offset,limit,history)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def save_structure_analysis(project_id: str,analysis_id: str,table_id: str | None,title: str,summary: str,data: dict,
                                reader: str,request_id: str,expected_revision: int=0,reason: str='',
                                related_tables: list[dict] | None=None,evidence_cells: list[str] | None=None,
                                related_sources: list[dict] | None=None) -> dict:
        """Persist YOUR interpretation so the person/model can resume it. No inference or model API is run.
        data is free JSON: column meanings, row sections, scope, mappings, calculations, questions, task coverage.
        reader=model|human have separate histories. related_tables needs table_id,relation,reason; all pointers
        must belong to this project and current source bytes. evidence_cells cite exact main/related cell_ids.
        related_sources cites up to 20 registered originals even without extracted tables (scans/schemes):
        doc_id, sha256, reason and optional physical PDF page_number. Changed originals stale the note.
        table_id=null is allowed for a source-only analysis; at least one table or related source is required.
        First revision=0; a correction needs previous expected_revision and reason. Same request_id only
        retries identical input. Engineering values are never approved. Read through get_project_structure
        kind=analyses (history=true for past revisions), or analyses in read_structure_table."""
        from .structure_analysis import StructureAnalysis
        return StructureAnalysis(workspace,project_id).save(analysis_id,table_id,title,summary,data,reader,request_id,
                                                            expected_revision,reason,related_tables,evidence_cells,related_sources)

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
