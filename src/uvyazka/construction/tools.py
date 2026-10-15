"""Register construction tools on the same MCP server as project memory."""
from .planning import Planning, duration_from_quantity


def register_tools(mcp, workspace):
    read = {"readOnlyHint": True, "idempotentHint": True}
    write = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True}

    @mcp.tool(annotations=read)
    def construction_schema() -> dict:
        """Read the document-independent work-graph and approximate spatial-model input contracts before creating them."""
        return {"time": "Integer continuous virtual minutes; no working calendars/weather. FS dependencies without lag. No automatic engineering approval.",
            "workflow": ["Read PDF/table evidence, inspect DWG using an available CAD MCP, or import a registered IFC", "Create an optional spatial model; boxes are approximate and need geometry_basis", "Save a source-labelled work graph, with explicit duration/productivity assumptions", "Run resource-constrained scenarios; inspect paged schedule/events and 3D playback"],
            "scenario_example": {"id": "foundation", "name": "Foundation scenario", "model_id": None,
                "resources": [{"id": "crew", "name": "Crew", "capacity": 1}], "assumptions": ["Synthetic example; durations require project confirmation"],
                "operations": [{"id": "excavate", "name": "Excavation", "kind": "earthworks", "duration": 120, "demands": {"crew": 1}, "dependencies": [], "target_ids": [],
                    "evidence": {"kind": "assumed", "reason": "Example only; specify actual source and duration basis"}}]},
            "duration_calculation": {"quantity": "100", "quantity_unit": "m3", "production_per_hour": "5", "production_unit": "m3", "note": "Effective rate of the whole assigned team; duration = ceil(60 * converted quantity / hourly rate). Do not multiply crew capacity twice."},
            "sources": "Each pointer is {doc_id,sha256,page_number,parser_revision} from read_evidence, {doc_id,sha256,locator} for a registered DWG/IFC, or {fact_id,revision}. Facts remain unapproved observations.",
            "spatial_element_example": {"id": "foundation-1", "name": "Foundation envelope", "bbox_min_m": [0,0,0], "bbox_max_m": [4,6,.4], "storey_id": "level-0", "geometry_basis": "Synthetic example. For drawings record dimensions, coordinate origin, units and scale evidence."},
            "revision": "Save with request_id. Existing scenarios require expected_revision. merge=true upserts supplied operations/resources; {id,remove:true} removes one. Dependencies must remain valid after every batch.",
            "limits": {"operations": 2000, "resources": 100, "spatial_elements": 5000, "read_page_max": 200},
            "view": "/simulation/?project=<project_id> in the local uvyazka dashboard"}

    @mcp.tool(annotations=read)
    def calculate_work_duration(calculation: dict) -> dict:
        """Calculate ceil(60*quantity/effective hourly production) with compatible explicit units. Input basis must be supplied by the agent, not guessed by this tool."""
        return {"duration_minutes": duration_from_quantity(calculation), "calculation": calculation, "approval_status": "unconfirmed"}

    @mcp.tool(annotations=write)
    def save_spatial_model(project_id: str, name: str, elements: list[dict], request_id: str, sources: list[dict] | None = None, assumptions: list[str] | None = None) -> dict:
        """Save approximate SI-metre boxes derived by the agent from PDF, DWG, tables or explicit assumptions. Read construction_schema first. Not an automatic PDF/DWG reconstruction or native BIM editor."""
        return Planning(workspace).save_model(project_id, name, elements, request_id, sources, assumptions)

    @mcp.tool(annotations=read)
    def list_spatial_models(project_id: str, offset: int = 0, limit: int = 40) -> dict:
        """List imported IFC and approximate document-led models in this project."""
        return Planning(workspace).list_models(project_id, offset, limit)

    @mcp.tool(annotations=read)
    def get_spatial_elements(project_id: str, model_id: str, offset: int = 0, limit: int = 40) -> dict:
        """Read bounded model elements with object IDs, properties, quantities and provenance."""
        return Planning(workspace).model_elements(project_id, model_id, offset, limit)

    @mcp.tool(annotations=write)
    def import_ifc_model(project_id: str, doc_id: str, request_id: str) -> dict:
        """Import a registered IFC source with optional IfcOpenShell. Preserves identifiers, relationships and geometry, not a verified technology or schedule. Large imports may need a longer client tool timeout."""
        return Planning(workspace).import_ifc(project_id, doc_id, request_id)

    @mcp.tool(annotations=write)
    def save_construction_scenario(project_id: str, scenario: dict, request_id: str, expected_revision: int | None = None, merge: bool = False) -> dict:
        """Create/revise/merge a work graph from any source format. Read construction_schema for fields. Every operation needs evidence and explicit minutes or a quantity/productivity calculation. Sources are checked; inputs remain unapproved. Previous versions survive."""
        return Planning(workspace).save_scenario(project_id, scenario, request_id, expected_revision, merge)

    @mcp.tool(annotations=read)
    def list_construction_scenarios(project_id: str, offset: int = 0, limit: int = 40) -> dict:
        """List the latest scenario versions for the selected project."""
        return Planning(workspace).list_scenarios(project_id, offset, limit)

    @mcp.tool(annotations=read)
    def get_construction_scenario(project_id: str, scenario_id: str, revision: int | None = None, offset: int = 0, limit: int = 40) -> dict:
        """Read bounded work rows, resources, assumptions and sources of a saved scenario version."""
        return Planning(workspace).scenario_page(project_id, scenario_id, revision, offset, limit)

    @mcp.tool(annotations=write)
    def suggest_ifc_scenario(project_id: str, model_id: str, scenario_id: str, request_id: str, variant: str = "base", expected_revision: int | None = None) -> dict:
        """Save IFCCS provisional work templates from IFC classes/materials. All technologies and seeded durations are assumptions. This is a starting hypothesis to edit, not a real construction plan."""
        return Planning(workspace).suggest_ifc_scenario(project_id, model_id, scenario_id, request_id, variant, expected_revision)

    @mcp.tool(annotations=write)
    def run_construction_scenario(project_id: str, scenario_id: str, revision: int | None = None, resource_overrides: dict | None = None) -> dict:
        """Calculate an immutable resource-feasible scenario and dependency-only CPM. Same inputs reproduce the run; capacities may be overridden without changing the saved version. Priority dispatch is not a proof of global optimum."""
        return Planning(workspace).run_scenario(project_id, scenario_id, revision, resource_overrides)

    @mcp.tool(annotations=read)
    def list_construction_runs(project_id: str, offset: int = 0, limit: int = 40) -> dict:
        """List calculated runs and their pinned scenario revisions."""
        return Planning(workspace).list_runs(project_id, offset, limit)

    @mcp.tool(annotations=read)
    def get_construction_run(project_id: str, run_id: str, section: str = "schedule", offset: int = 0, limit: int = 40) -> dict:
        """Read bounded schedule rows or events. Schedule contains starts, finishes, demands, provenance and dependency-only CPM floats. Simulation events are not actual construction records."""
        return Planning(workspace).run_page(project_id, run_id, section, offset, limit)
