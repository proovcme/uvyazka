"""MCP entrypoints for cached native data, views and schedules."""
from .rvt_data import RvtData


def register_tools(mcp,workspace):
    read={'readOnlyHint':True,'idempotentHint':True}

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def prepare_rvt_model(project_id:str,doc_id:str,request_id:str,convert_geometry:bool=True) -> dict:
        """Agent entrypoint: automatically extract/cache all supported native RVT data, convert to IFC and validate/publish geometry without Revit. Registered source required; build the Rust runtime and install authoring extra for geometry first. Independent stage errors preserve successful data/geometry. Returns extraction_id/model_id, exact ElementId crosswalk, coverage and next tools. Same request_id returns its report; after fixing a failed stage use a new ID. Synchronous, bounded to <=512 MiB and per-stage timeouts. Does not generate evaluated schedules, drawings or an approved construction plan."""
        from .rvt_preparation import prepare
        return prepare(workspace,project_id,doc_id,request_id,convert_geometry)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def extract_rvt_data(project_id:str,doc_id:str,request_id:str,profile:str='all') -> dict:
        """Extract and cache saved native RVT data without IFC conversion or Revit. Requires the built runtime. profile=all, views (also schedules/placements), or schedules. Returns extraction_id, source SHA, counts and partial/unsupported diagnostics. Values are serialized, not evaluated by Revit; repeated inputs reuse the snapshot. No source file is modified."""
        return RvtData(workspace).extract(project_id,doc_id,request_id,profile)

    @mcp.tool(annotations=read)
    def get_rvt_data(project_id:str,extraction_id:str,section:str='elements',query:str='',offset:int=0,limit:int=40,json_path:list[str|int]|None=None,max_chars:int=6000) -> dict:
        """Read a bounded cached RVT inventory without Revit. Sections: summary, coverage (by native class), units, parameter_definitions, classes, elements (all record kinds), views, schedules, placements, diagnostics. record_id addresses get_rvt_record. section=value reads extraction-report JSON by json_path with character continuation. Source SHA identifies the snapshot, not the approved revision. Saved unit formats do not by themselves convert raw values to SI."""
        return RvtData(workspace).read(project_id,extraction_id,section,query,offset,limit,json_path,max_chars)

    @mcp.tool(annotations=read)
    def get_rvt_record(project_id:str,extraction_id:str,record_id:int,section:str='fields',offset:int=0,limit:int=40,json_path:list[str|int]|None=None,max_chars:int=6000) -> dict:
        """Read cached RVT fields, parameters, view settings, graph objects, schedule_definition (filters/sorting/settings), schedule_fields or schedule_cells without Revit. For a truncated row use section=value, json_path and character offset; next_offset continues JSON text. Saved cells do not prove evaluated body rows or typed quantities; view settings are not rendered drawings. Missing remains missing; raw values and source addresses are preserved."""
        return RvtData(workspace).record(project_id,extraction_id,record_id,section,offset,limit,json_path,max_chars)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':False})
    def export_rvt_record(project_id:str,extraction_id:str,record_id:int,format:str='json') -> dict:
        """Export a cached native RVT record to local JSON or saved schedule cells to long-form CSV. Requires no Revit, IFC or model API. Creates a new project artifact and source manifest with SHA; original RVT stays untouched. CSV has one saved cell per row, JSON-encoded text and explicit nulls; it is not an evaluated original schedule or regenerated drawing."""
        return RvtData(workspace).export_record(project_id,extraction_id,record_id,format)
