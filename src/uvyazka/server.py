"""Local MCP interface. The host supplies the model; this server has no model client."""
from __future__ import annotations

from .core import Workspace


def build_server(workspace: Workspace | None = None):
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:
        raise RuntimeError("Install the MCP extra: pip install 'uvyazka[mcp]'") from exc
    memory = workspace or Workspace()
    mcp = FastMCP("uvyazka")
    read = {"readOnlyHint": True, "idempotentHint": True}

    @mcp.tool(annotations=read)
    def list_technology_sources(query: str = "") -> dict:
        """Find metadata of manually inspected TTK reference cards. These are candidates, not accepted current project requirements."""
        from .library import list_technology_sources as list_sources
        return list_sources(query)

    @mcp.tool(annotations=read)
    def list_projects() -> dict:
        """List explicitly registered projects. Choose project_id for every subsequent call."""
        return memory.list_projects()

    @mcp.tool(annotations=read)
    def project_status(project_id: str) -> dict:
        """Read inventory/extraction coverage before using project facts. Indexing is not engineering acceptance."""
        return memory.project_status(project_id)

    @mcp.tool(annotations=read)
    def find_documents(project_id: str, query: str = "", limit: int = 20, offset: int = 0) -> dict:
        """Find source IDs, content hashes and format statuses by filename, with a continuation cursor."""
        return memory.find_documents(project_id, query, limit, offset)

    @mcp.tool(annotations=read)
    def search_project(project_id: str, query: str, limit: int = 6, doc_id: str | None = None) -> dict:
        """Search cached text with literal keyword prefixes. Returns bounded snippets; open the source before accepting numbers."""
        return memory.search_project(project_id, query, limit, doc_id)

    @mcp.tool(annotations=read)
    def read_evidence(project_id: str, doc_id: str, page_number: int = 1, offset: int = 0, max_chars: int = 5000, sha256: str | None = None, parser_revision: str | None = None) -> dict:
        """Read one bounded page/block and its literal locator; continue via next_offset. PDF page differs from drawing sheet."""
        return memory.read_evidence(project_id, doc_id, page_number, offset, max_chars, sha256, parser_revision)

    @mcp.tool(annotations=read)
    def get_project_facts(project_id: str, group: str | None = None) -> dict:
        """Read current recorded observations and source freshness. They are not automatically accepted engineering values."""
        return memory.get_project_facts(project_id, group)

    @mcp.tool(annotations=read)
    def get_reconciliation(project_id: str, status: str | None = None) -> dict:
        """Read comparable-quantity checks and unresolved/stale inputs. A complete audit requires explicit source coverage."""
        return memory.get_reconciliation(project_id, status)

    @mcp.tool(annotations=read)
    def get_evidence_chain(project_id: str, fact_id: str) -> dict:
        """Trace a recorded observation, its revision history, exact sources and dependent checks."""
        return memory.get_evidence_chain(project_id, fact_id)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True})
    def record_observations(project_id: str, observations: list[dict], request_id: str) -> dict:
        """Append 1–40 unapproved source observations. Each needs name, group, value, raw_value, unit, basis, sources.
        Each source needs doc_id, sha256, page_number (from read_evidence); raw_value must occur in every cited block.
        For comparison include entity, property, specification and revision_set. A correction reuses id, adds
        expected_revision and correction_reason, retains history and invalidates dependent checks.
        Reuse request_id only for an identical retry. This tool never approves a technical decision or edits originals.
        """
        return memory.record_observations(project_id, observations, request_id)

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False})
    def compare_facts(project_id: str, first_id: str, second_id: str, tolerance: str = "0") -> dict:
        """Store a decimal comparison with explicit units, matching entity/property/basis/revision/specification.
        Tolerance is in base units (m, m2, m3, kg, kW). This compares recorded quantities, not an entire project.
        """
        return memory.compare_facts(project_id, first_id, second_id, tolerance)

    from .construction.tools import register_tools
    register_tools(mcp, memory)
    from .coordination import register_tools as register_coordination
    register_coordination(mcp, memory)
    from .construction.authoring_tools import register_tools as register_authoring
    register_authoring(mcp,memory)
    from .construction.rvt_data_tools import register_tools as register_rvt_data
    register_rvt_data(mcp,memory)
    from .measurement_tools import register_tools as register_measurements
    register_measurements(mcp, memory)
    return mcp


def main():
    # Load optional native libraries before the stdio event loop on Windows.
    import importlib.util
    if importlib.util.find_spec("ifcopenshell"):
        import numpy
        import ifcopenshell
    build_server().run(transport="stdio")


if __name__ == "__main__":
    main()
