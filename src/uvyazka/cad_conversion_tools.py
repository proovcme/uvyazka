"""Explicit local CAD conversion, separate from default direct-file readers."""
from .cad_conversion import CADConversions,converter_status


def register_tools(mcp,workspace):
    service=CADConversions(workspace)
    read={'readOnlyHint':True,'idempotentHint':True}

    @mcp.tool(annotations=read)
    def cad_converter_status() -> dict:
        """Check locally configured external ODA File Converter and pinned runtime hashes. No file conversion, installation, AutoCAD or cloud access. Configure through the local CLI, never document-supplied commands."""
        return converter_status(workspace.home)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def convert_cad_document(project_id:str,doc_id:str,request_id:str,output_format:str='DWG',version:str='ACAD2018') -> dict:
        """Convert ONE registered DXF->DWG or DWG->DXF using an explicitly configured external ODA installation. Source hashes are checked; originals stay read-only. Outputs and a report are saved in project state. DXF->DWG reopens through ODA to DXF and checks supported 2D blocks/attributes, geometry, text/styles, layouts and viewport scales; normalizations stay explicit. DWG->DXF is converted_unverified. No PDF print, font embedding or engineering approval. Same request_id returns its saved outcome, including failures; inspect before a new retry."""
        return service.convert(project_id,doc_id,request_id,output_format,version)

    @mcp.tool(annotations=read)
    def get_cad_conversion(project_id:str,conversion_id:str,section:str='summary') -> dict:
        """Read project-scoped CAD conversion summary, validation or diagnostics. Rechecks original and artifact hashes; stale sources stay explicit. Running/interrupted/failed results are not retried automatically. Exact paths and full report are local artifacts, not approved drawing revisions."""
        return service.get(project_id,conversion_id,section)
