"""Source-labelled bounding boxes for document-led modelling, without IFC dependencies."""
from __future__ import annotations

import math
import struct

from .simulation import canonical_hash


def box_model(name: str, elements: list[dict], sources: list[dict], assumptions: list[str]) -> tuple[dict, bytes]:
    if not name.strip() or not 1 <= len(elements) <= 5000:
        raise ValueError("A name and 1–5000 spatial elements are required")
    payload = {"name": name, "elements": elements, "sources": sources, "assumptions": assumptions}
    model_id = canonical_hash(payload)
    rows = []; seen = set()
    for index, item in enumerate(elements, 1):
        key = str(item["id"])
        if not key or len(key) > 80 or key in seen:
            raise ValueError("Spatial element IDs must be unique, nonempty and <=80 characters")
        seen.add(key)
        lower, upper = item["bbox_min_m"], item["bbox_max_m"]
        if len(lower) != 3 or len(upper) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 1e8 for v in [*lower, *upper]):
            raise ValueError("Box coordinates must be three finite SI metre values")
        if any(a >= b for a, b in zip(lower, upper)):
            raise ValueError("Every box dimension must be positive")
        if not item.get("geometry_basis"):
            raise ValueError("Each box needs geometry_basis explaining measurements, scale or assumptions")
        color = item.get("color", [.34, .53, .55])
        if len(color) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in color):
            raise ValueError("Color must contain three values between 0 and 1")
        rows.append({"id": key, "step_id": index, "global_id": item.get("global_id", ""),
            "class": item.get("class", "DocumentElement"), "hierarchy": [item.get("class", "DocumentElement")],
            "name": item.get("name", key), "role": "element", "storey_id": str(item.get("storey_id", "unassigned")),
            "predefined_type": None, "materials": item.get("materials", []), "property_sets": {}, "quantity_sets": {},
            "source": {"kind": "derived", "file_sha256": model_id, "step_id": index, "geometry_basis": item["geometry_basis"], "sources": item.get("sources", sources)},
            "geometry_error": None, "mesh": {"bbox_min_m": lower, "bbox_max_m": upper, "representation_id": index,
                "vertex_count": 8, "index_count": 36, "styles": [{"name": "Approximate envelope", "color": color, "opacity": 1}],
                "groups": [{"start": 0, "count": 36, "material_index": 0}],
                "source": {"kind": "derived", "method": "document_bounding_box", "version": "0.2.0", "representation_id": index}}})
    lower = [min(e["mesh"]["bbox_min_m"][i] for e in rows) for i in range(3)]
    upper = [max(e["mesh"]["bbox_max_m"][i] for e in rows) for i in range(3)]
    origin = [(lower[0] + upper[0]) / 2, (lower[1] + upper[1]) / 2, lower[2]]
    data = bytearray()
    triangles = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]
    for row in rows:
        mesh = row["mesh"]; a, b = mesh["bbox_min_m"], mesh["bbox_max_m"]
        vertices = [(a[0],a[1],a[2]),(b[0],a[1],a[2]),(b[0],b[1],a[2]),(a[0],b[1],a[2]),
                    (a[0],a[1],b[2]),(b[0],a[1],b[2]),(b[0],b[1],b[2]),(a[0],b[1],b[2])]
        mesh["position_byte_offset"] = len(data)
        data.extend(struct.pack("<24f", *(v[i] - origin[i] for v in vertices for i in range(3))))
        mesh["index_byte_offset"] = len(data); data.extend(struct.pack("<36I", *triangles))
    storeys = [{"id": key, "name": key, "elevation_m": min(e["mesh"]["bbox_min_m"][2] for e in rows if e["storey_id"] == key),
                "placement_origin_m": None, "element_count": sum(e["storey_id"] == key for e in rows)} for key in sorted({e["storey_id"] for e in rows})]
    return {"contract": "ModelPackage", "contract_version": "0.1.0", "importer_version": "document-boxes-0.2.0", "model_id": model_id,
        "source": {"filename": name, "sha256": model_id, "size_bytes": 0, "schema": "DocumentSpatialModel", "exported_at": "", "exporter": "uvyazka",
                   "kind": "derived", "sources": sources, "assumptions": assumptions},
        "coordinate_system": {"length_to_m": 1, "render_origin_m": origin, "up_axis": "Z", "bounds_min_m": lower, "bounds_max_m": upper},
        "storeys": storeys, "elements": rows, "relationships": [], "diagnostics": [],
        "statistics": {"products": len(rows), "physical_elements": len(rows), "meshes": len(rows), "triangles": len(rows)*12, "geometry_errors": 0, "binary_bytes": len(data)},
        "capabilities": {"read": True, "geometry_ready": True, "technology_resolved": False, "schedule_ready": False}}, bytes(data)
