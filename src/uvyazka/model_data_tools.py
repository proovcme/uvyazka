"""Small shared model-data interface; optional engines load only on explicit reads."""
from .model_data import ModelData
from .model_readers import reader_status


def register_tools(mcp, workspace):
    service = ModelData(workspace)
    read = {'readOnlyHint': True, 'idempotentHint': True}

    @mcp.tool(annotations=read)
    def model_reader_status() -> dict:
        """List local direct-file readers for RVT, IFC, DWG, DXF, NWD/NWC and setup instructions. Metadata scope only; no Revit/AutoCAD/cloud required. Availability is not proof that every format version/object is decoded."""
        return reader_status(workspace)

    @mcp.tool(annotations={'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': True})
    def read_model_data(project_id: str, request_id: str, doc_id: str | None = None, scene_id: str | None = None) -> dict:
        """Persist an immutable metadata snapshot in the shared project DB. Exactly one registered doc_id OR saved viewer scene_id. Direct RVT/IFC/DWG/DXF/NWD/NWC reads need the respective local reader. No original edits or LLM API. Repeated source/reader versions reuse cache; changed files require scan and a new request_id. scene_id uses an unreviewed derived viewer package, not a reread of the original. Inspect coverage/limitations: saved views are not rendered drawings, schedule definitions are not evaluated totals, Navis logical nodes are not physical quantities. Returns dataset_id for query_model_data/get_model_object."""
        return service.read(project_id, request_id, doc_id, scene_id)

    @mcp.tool(annotations=read)
    def list_model_data(project_id: str, offset: int = 0, limit: int = 20) -> dict:
        """Resume saved model datasets and coverage in the selected project's DB. No original parsing. Different source hashes/readers remain separate snapshots. Freshness uses file metadata, not approved revisions."""
        return service.list(project_id, offset, limit)

    @mcp.tool(annotations=read)
    def query_model_data(project_id: str, dataset_id: str, section: str = 'elements', query: str = '', native_id: str | None = None,
                         filters: list[dict] | None = None, cursor: str | None = None, limit: int = 40) -> dict:
        """Search cached elements/types/systems/levels/layers/blocks/layouts/views/schedules/relationships. query is name/class/native ID substring; native_id exact ID or explicit identifier alias, never guessed name matching. filters (max8): {path:["properties",...],op:"eq|contains|exists|gt|lt",value:...}. eq is type-exact, exists distinguishes absent from null/zero; numeric comparisons do not convert units. Follow next_cursor even for an empty page. Native IDs can be ambiguous; use returned object_id for detail. Empty results prove nothing about unsupported source data. No model/file edits."""
        return service.query(project_id, dataset_id, section, query, native_id, filters, cursor, limit)

    @mcp.tool(annotations=read)
    def get_model_object(project_id: str, dataset_id: str, object_id: str, json_path: list | None = None,
                         offset: int = 0, max_chars: int = 6000, verify_source: bool = False) -> dict:
        """Read one cached object's properties, exact native identifiers and field evidence by JSON path, with character continuation. object_id=@dataset reads the complete extraction report (e.g. json_path=["coverage"]); navigation responses show bounded previews. Concatenate text pages before parsing JSON. verify_source hashes current registered bytes; also check current_registered_version against this snapshot. Units stay native, saved values may be unevaluated/partial. RVT evidence links extraction_id/record_id to get_rvt_record for full graphs; no geometry conversion or approval."""
        return service.object(project_id, dataset_id, object_id, json_path, offset, max_chars, verify_source)
