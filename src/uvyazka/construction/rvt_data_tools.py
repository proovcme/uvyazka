"""MCP entrypoints for cached native data, views and schedules."""
from .rvt_data import RvtData


def register_tools(mcp,workspace):
    read={'readOnlyHint':True,'idempotentHint':True}

    @mcp.tool(annotations=read)
    def list_rvt_catalogs(project_id:str,source_sha256:str='',offset:int=0,limit:int=40) -> dict:
        """List immutable RVT snapshots in the shared project DB, including catalogues imported from the viewer and native MCP extractions. Match by exact original RVT SHA, never filename. Read records with get_rvt_data/get_rvt_record using extraction_id. Imported JSON source hashes are declared, not proof that the RVT was reopened. Missing records do not establish absence."""
        from .rvt_catalog import RvtCatalog
        return RvtCatalog(workspace).list(project_id,source_sha256,offset,limit)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def import_rvt_catalog(project_id:str,doc_id:str,request_id:str) -> dict:
        """Import a registered viewer catalogue JSON into the same RVT record store used by MCP and the local viewer. Preserves source SHA, original IDs/graphs/parameters and partial status, without uploading or modifying RVT. Requires the JSON file to be registered in this project. Declared RVT SHA is not independently verified. Same request_id is immutable; different contents are a conflict."""
        from .rvt_catalog import RvtCatalog
        return RvtCatalog(workspace).import_document(project_id,doc_id,request_id)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def prepare_rvt_model(project_id:str,doc_id:str,request_id:str,convert_geometry:bool=True) -> dict:
        """Agent entrypoint: automatically extract/cache all supported native RVT data, convert to IFC and validate/publish geometry without Revit. Registered source required; build the Rust runtime and install authoring extra for geometry first. Independent stage errors preserve successful data/geometry. Returns extraction_id/model_id, exact ElementId crosswalk, coverage and next tools. Same request_id returns its report; after fixing a failed stage use a new ID. Synchronous, bounded to <=512 MiB and per-stage timeouts. Does not generate evaluated schedules, drawings or an approved construction plan."""
        from .rvt_preparation import prepare
        return prepare(workspace,project_id,doc_id,request_id,convert_geometry)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def extract_rvt_data(project_id:str,doc_id:str,request_id:str,profile:str='all') -> dict:
        """Extract and cache saved native RVT data without IFC conversion or Revit. Requires built runtime. Profiles: parameters (compact instance/type data for tables, shared with browser); all; views (also schedules/placements); schedules; engineering; types; objects; systems. Parameters include decoded workset names and shared parameter definitions. Records are read in bounded pages; continuation is completed before saving. Returns extraction_id, SHA, counts and explicit partial/unsupported diagnostics. Values are saved, not evaluated; repeat inputs reuse the snapshot. No source modification."""
        return RvtData(workspace).extract(project_id,doc_id,request_id,profile)

    @mcp.tool(annotations=read)
    def get_rvt_data(project_id:str,extraction_id:str,section:str='elements',query:str='',offset:int=0,limit:int=40,json_path:list[str|int]|None=None,max_chars:int=6000) -> dict:
        """Read a bounded cached RVT inventory without Revit. Sections: summary, coverage (by native class), units, parameter_definitions, classes, elements (all record kinds), views, schedules, placements, systems, diagnostics. record_id addresses get_rvt_record. section=value reads extraction-report JSON by json_path with character continuation. Source SHA identifies the snapshot, not the approved revision. Saved unit formats do not by themselves convert raw values to SI."""
        return RvtData(workspace).read(project_id,extraction_id,section,query,offset,limit,json_path,max_chars)

    @mcp.tool(annotations=read)
    def find_rvt_parameters(project_id:str,extraction_id:str,query:str='',element_id:str='',class_name:str='',cursor:dict|None=None,limit:int=40,max_scan_records:int=25) -> dict:
        """Search cached native RVT parameter projections without reopening the RVT, Revit or IFC. query is a case-insensitive substring of saved JSON; element_id/class_name are exact filters. Returns raw values/definitions/slots with record_id, native source and json_path; does not infer units or evaluate formulas. Follow next_cursor even for an empty batch. search_exhausted means the cached search ended, not complete source extraction or verified absence. Truncated entries can be read with get_rvt_record(section=value)."""
        return RvtData(workspace).search_parameters(project_id,extraction_id,query,element_id,class_name,cursor,limit,max_scan_records)

    @mcp.tool(annotations=read)
    def get_rvt_record(project_id:str,extraction_id:str,record_id:int,section:str='fields',offset:int=0,limit:int=40,json_path:list[str|int]|None=None,max_chars:int=6000) -> dict:
        """Read cached RVT fields, parameters, view settings, graph objects, mep_system (Unicode name and explicit member references, including electrical base equipment), schedule_definition, schedule_fields or schedule_cells without Revit. MEP membership is saved evidence, not an engineering completeness approval; missing projections remain unavailable. For a truncated row use section=value, json_path and character offset. Saved cells do not prove evaluated body rows; view settings are not rendered drawings."""
        return RvtData(workspace).record(project_id,extraction_id,record_id,section,offset,limit,json_path,max_chars)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':False})
    def export_rvt_record(project_id:str,extraction_id:str,record_id:int,format:str='json') -> dict:
        """Export a cached native RVT record to local JSON or saved schedule cells to long-form CSV. Requires no Revit, IFC or model API. Creates a new project artifact and source manifest with SHA; original RVT stays untouched. CSV has one saved cell per row, JSON-encoded text and explicit nulls; it is not an evaluated original schedule or regenerated drawing."""
        return RvtData(workspace).export_record(project_id,extraction_id,record_id,format)
