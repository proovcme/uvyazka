"""MCP bridge: engineering methods, source-pinned cases and document operations."""
import asyncio

from .engineering_calculations import catalog
from .engineering_documents import EngineeringDocuments, schema
from .engineering_work import EngineeringWork


def register_tools(mcp,workspace):
    read={'readOnlyHint':True,'idempotentHint':True}
    write={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True}

    @mcp.tool(annotations=read)
    def list_engineering_methods() -> dict:
        """List implemented engineering kernels, exact input units/domains, assumptions,
        coverage and pinned ru-aec skill links. No automatic normative threshold or
        complete coupled-network design. Read before running a calculation."""
        return catalog()

    @mcp.tool(annotations=write)
    async def run_engineering_calculation(project_id:str,calculation_id:str,title:str,method:str,
            inputs:dict,basis:str,request_id:str,sources:list[dict]|None=None,assumptions:list[str]|None=None,
            reported_results:dict|None=None,criteria:list[dict]|None=None,expected_revision:int=0,reason:str='')->dict:
        """Calculate a typed engineering case and persist its trace in the project DB.
        Supply the exact method inputs from list_engineering_methods. Cite up to 20
        registered {doc_id,sha256,reason,page_number?} originals or explicit assumptions.
        Optional reported_results compare published outputs with explicit absolute
        tolerances; criteria check caller-established bounds, not legal applicability.
        Correction needs expected_revision and reason. Never edits originals or approves design."""
        return await asyncio.to_thread(EngineeringWork(workspace,project_id).run,
            calculation_id,title,method,inputs,basis,sources or [],assumptions or [],request_id,
            reported_results,criteria,expected_revision,reason)

    @mcp.tool(annotations=read)
    def get_engineering_work(project_id:str,kind:str,item_id:str|None=None,revision:int|None=None,
                             offset:int=0,limit:int=20)->dict:
        """Resume calculation, document or document_check records. An exact item_id returns
        full saved inputs/results; a list returns summaries. Revision selects immutable
        history. Actual source hashes, method version and corrected calculation dependencies
        remain visible; historical results never silently become current approval."""
        return EngineeringWork(workspace,project_id).get(kind,item_id,revision,offset,limit)

    @mcp.tool(annotations=read)
    def engineering_document_schema()->dict:
        """Read report/vector-sheet, metadata, symbol legend and PDF-check contracts.
        Generated working layouts still need applicable SPDS form/font/symbol review;
        PDF tests report only their exact selected pages and explicit criteria."""
        return schema()

    @mcp.tool(annotations=write)
    async def build_engineering_document(project_id:str,document_id:str,title:str,metadata:dict,
            basis:str,request_id:str,calculations:list[dict]|None=None,pages:list[dict]|None=None,
            symbols:list[dict]|None=None,sources:list[dict]|None=None,assumptions:list[str]|None=None,
            expected_revision:int=0,reason:str='')->dict:
        """Create a local PDF calculation report and/or vector drawing sheets with a frame,
        metadata and same-sheet symbol legends. Read engineering_document_schema first.
        Pin calculation IDs and revisions; do not invent signed approvals or normative
        symbol provenance. Outputs and manifests stay in this project's export folder.
        The working layout does not certify every corrected SPDS form or statutory requirement."""
        return await asyncio.to_thread(EngineeringDocuments(workspace,project_id).build,
            document_id,title,metadata,calculations or [],pages or [],symbols or [],basis,
            sources or [],assumptions or [],request_id,expected_revision,reason)

    @mcp.tool(annotations=write)
    async def check_engineering_document(project_id:str,check_id:str,title:str,pages:list[int],
            requirements:list[dict],basis:str,request_id:str,document_id:str|None=None,
            document_revision:int|None=None,doc_id:str|None=None,sha256:str|None=None,
            expected_revision:int=0,reason:str='')->dict:
        """Check actual PDF bytes for page sizes, native vector frame, font em sizes and
        required text in explicit regions; save source-pinned results. Choose a generated
        document OR registered doc_id/sha256, with 1–10 physical pages. Every requirement
        needs an applicability basis from engineering_document_schema. Raster/unsupported
        checks remain unchecked, and a missing text layer does not prove a missing field.
        Does not certify UGO meaning, signatures, engineering completeness or legal approval."""
        return await asyncio.to_thread(EngineeringDocuments(workspace,project_id).check,
            check_id,title,pages,requirements,basis,request_id,document_id,document_revision,
            doc_id,sha256,expected_revision,reason)
