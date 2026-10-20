"""Small MCP toolkit; interpretation remains with the calling model."""
from .measurements import Measurements


def register_tools(mcp, workspace):
    from mcp.server.fastmcp import Image
    from .core import encode
    read = {"readOnlyHint": True, "idempotentHint": True}
    write = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True}

    @mcp.tool(annotations=read)
    def inspect_measurement_sheet(project_id: str, doc_id: str, sha256: str, page_number: int = 1,
                                  region: list[float] | None = None, offset: int = 0, limit: int = 100,
                                  section: str = "text") -> dict:
        """Read PDF dimensions and positioned words or drawing primitives (section=text|vectors),
        in unrotated top-left PDF points (not pixels). Vector regions select intersecting paths, not clipped
        segments; primitives keep lines/rectangles/quads/Bezier control points, not inferred walls.
        Use current registered hash. No OCR or view recognition. Pick each view region yourself.
        Render the same coordinate frame with render_drawing_measurements before choosing control points."""
        return Measurements(workspace, project_id).inspect(doc_id, sha256, page_number, region, offset, limit, section)

    @mcp.tool(annotations=write)
    def save_drawing_view(project_id: str, view: dict, expected_revision: int, request_id: str) -> dict:
        """Persist a model-identified PDF view. Required: id,doc_id,sha256,page_number,name,kind,
        region=[x0,y0,x1,y1] in unrotated PDF points,measurement_basis,reason.
        Optional sheet_label,orientation_degrees (descriptive, does not rotate coordinates).
        expected_revision=0 creates; an update requires current revision and invalidates dependent calibration.
        No inherited sheet scale or automatic recognition. Same request_id is for identical retries only."""
        return Measurements(workspace, project_id).save_view(view, expected_revision, request_id)

    @mcp.tool(annotations=write)
    def calibrate_drawing_view(project_id: str, view_id: str, expected_view_revision: int,
                               expected_calibration_revision: int, points: list[list[float]],
                               length_m: float, basis: str, request_id: str) -> dict:
        """Save two control points and their real length in metres for ONE view.
        basis cites the dimension/interpretation. Uniform planar scale only; broken/perspective/distorted
        views need another method. Calibration is agent-proposed, not engineering approval.
        Revision 0 creates; changing it makes old measurements stale, retaining their previous values."""
        return Measurements(workspace, project_id).calibrate(view_id, expected_view_revision,
            expected_calibration_revision, points, length_m, basis, request_id)

    @mcp.tool(annotations=write)
    def measure_drawing_view(project_id: str, view_id: str, view_revision: int, calibration_revision: int,
                             items: list[dict], request_id: str) -> dict:
        """Atomically calculate/save 1–40 measurements in one calibrated view.
        Each item: id,name,kind=length|area,points=[[x,y],...],basis,reason; optional entity_ref,
        expected_revision (0=new). Simple polygons only; no holes, curves or volume inference.
        Coordinates remain source PDF points. Reuse the current revision to correct an existing record.
        Returns calculated_unreviewed values. Inspect overlay next; this does not create a verified project fact."""
        return Measurements(workspace, project_id).measure(view_id, view_revision, calibration_revision, items, request_id)

    @mcp.tool(annotations=read)
    def get_drawing_measurements(project_id: str, kind: str = "view", view_id: str | None = None,
                                 record_id: str | None = None, history: bool = False,
                                 offset: int = 0, limit: int = 40) -> dict:
        """Resume persistent project drawing work: list view/calibration/measurement records, revisions and
        stale reasons, with pagination. history=true retains earlier values. Counts are recorded work,
        not total project coverage. Freshness checks actual source bytes; it is not revision acceptance."""
        return Measurements(workspace, project_id).context(kind, view_id, record_id, history, offset, limit)

    @mcp.tool(annotations=write)
    def recalculate_drawing_measurements(project_id: str, view_id: str, view_revision: int,
                                         calibration_revision: int, items: list[dict], reason: str, request_id: str) -> dict:
        """After a scale correction, atomically recalculate 1–40 {id,expected_revision} measurements
        in the SAME view revision; preserve old results and reason. A replaced source or edited view
        requires geometry inspection and measure_drawing_view correction instead. Never promotes to approved."""
        return Measurements(workspace, project_id).recalculate(view_id, view_revision,
            calibration_revision, items, reason, request_id)

    @mcp.tool(annotations=write)
    def review_drawing_measurements(project_id: str, items: list[dict], request_id: str) -> dict:
        """Persist the calling agent's visual review or question after inspecting the source overlay.
        Each of 1–40 items: id,expected_revision,verdict=geometry_checked|question,note.
        Does not prove a review happened or grant human approval. Stale inputs refuse.
        Recalculation clears this review and requires a new one."""
        return Measurements(workspace, project_id).review(items, request_id)

    @mcp.tool(annotations=read)
    def render_drawing_measurements(project_id: str, doc_id: str, sha256: str, page_number: int = 1,
                                    view_id: str | None = None, measurement_ids: list[str] | None = None) -> list:
        """Return coordinate mapping plus PNG of the source page or saved view, with up to 40 saved
        measurement contours. Red=stale scale, amber=unreviewed, blue=calibration. PDF remains untouched.
        Use this image to check what was measured; source replacement refuses instead of overlaying old geometry."""
        metadata, png = Measurements(workspace, project_id).render(doc_id, sha256, page_number, view_id, measurement_ids)
        return [encode(metadata), Image(data=png, format="png")]
