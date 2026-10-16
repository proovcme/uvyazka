"""SI quantity evidence. Geometry is measured before GPU float32 conversion."""
from __future__ import annotations

import math
import numpy as np


def quantity(value, unit, kind, method, **evidence):
    return {"value": float(value), "unit": unit, "kind": kind, "method": method, **evidence}


def explicit_quantities(product, model):
    import ifcopenshell.util.element as elements
    import ifcopenshell.util.unit as units
    result = {}
    specs = {"IfcQuantityVolume": ("VolumeValue", "VOLUMEUNIT", "m3"),
             "IfcQuantityArea": ("AreaValue", "AREAUNIT", "m2"),
             "IfcQuantityLength": ("LengthValue", "LENGTHUNIT", "m"),
             "IfcQuantityWeight": ("WeightValue", "MASSUNIT", "kg")}
    # Restrict to standard BaseQuantities, retaining inherited type quantities.
    for name, values in elements.get_psets(product, qtos_only=True, should_inherit=True).items():
        if not (name == "BaseQuantities" or name.startswith("Qto_") and name.endswith("BaseQuantities")):
            continue
        definition = model.by_id(values["id"])
        for item in definition.Quantities:
            if item.is_a() not in specs:
                continue
            attribute, unit_type, symbol = specs[item.is_a()]
            unit = item.Unit or units.get_project_unit(model, unit_type)
            # No area/volume assignment means unknown; never silently cube a length unit.
            if unit is None:
                continue
            factor = units.get_unit_scale(unit)
            if unit_type == "MASSUNIT":
                factor /= 1000  # IfcSIUnit GRAM -> kg
            value = getattr(item, attribute) * factor
            if math.isfinite(value) and value > 0:
                result[item.Name] = quantity(value, symbol, "explicit", "ifc_base_quantity",
                    quantity_id=item.id(), quantity_set=name, unit_id=unit.id(), source_value=getattr(item, attribute))
    return result


def mesh_quantities(vertices, faces):
    """Closed mesh volume; one-sided horizontal/vertical area and form contact.

    Side area is half the absolute vertical triangle area (two wall faces).
    Formwork is sides plus downward faces; below-grade bearing faces are excluded
    later by the technology package. These are geometric estimates, not a takeoff
    approved for temporary works.
    """
    v = np.asarray(vertices, dtype=float)
    f = np.asarray(faces, dtype=int)
    triangles = v[f] - v.mean(axis=0)
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    areas = np.linalg.norm(cross, axis=1) / 2
    nz = np.divide(cross[:, 2], 2 * areas, out=np.zeros(len(areas)), where=areas > 1e-12)
    edges = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    closed = bool(len(counts) and (counts == 2).all())
    derived = lambda x, u, method: quantity(x, u, "derived", method)
    result = {"surface_area": derived(areas.sum(), "m2", "mesh_triangle_area"),
        "side_area": derived(areas[np.abs(nz) < .5].sum() / 2, "m2", "half_vertical_surface"),
        "plan_area": derived((areas * np.abs(nz)).sum() / 2, "m2", "half_projected_horizontal_surface"),
        "form_sides": derived(areas[np.abs(nz) < .5].sum(), "m2", "mesh_vertical_contact"),
        "form_soffit": derived(areas[nz < -.5].sum(), "m2", "mesh_downward_contact"),
        "mesh_closed": closed}
    if closed:
        volume = abs(np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum() / 6)
        if volume > 1e-10:
            result["volume"] = derived(volume, "m3", "closed_mesh_signed_tetrahedra")
    return result


def unit_quantities(parts, family, include_soffit):
    result = {}
    for key, aliases, unit in (("volume", ("NetVolume", "GrossVolume"), "m3"),
            ("mass", ("NetWeight", "GrossWeight"), "kg"),
            ("area", ("NetSideArea", "GrossSideArea") if family == "IfcWall" else ("Area", "NetArea", "GrossArea") if family in ("IfcDoor", "IfcWindow") else ("NetArea", "GrossArea"), "m2"),
            ("formwork_area", (), "m2"), ("length", ("Length", "NetLength", "GrossLength"), "m")):
        evidence, total = [], 0.
        for part in parts:
            if part.get("geometry_evidence", {}).get("quantity_eligible") is False:
                evidence.append({"element_id": part["id"], "kind": "unavailable",
                    "reason": "converter_geometry_not_quantity_eligible", "geometry_evidence": part["geometry_evidence"]})
                continue
            explicit = part.get("quantities", {})
            measured = part.get("measured_quantities", {})
            q = next((explicit[name] for name in aliases if name in explicit and explicit[name]["unit"] == unit and explicit[name]["value"] > 0), None)
            if q is None:
                fallback = "length" if key == "length" else "volume" if key == "volume" else "mass" if key == "mass" else "side_area" if family in ("IfcWall", "IfcDoor", "IfcWindow") else "plan_area"
                if key == "formwork_area":
                    values = [measured[name] for name in ("form_sides", "form_soffit") if name in measured and (name != "form_soffit" or include_soffit)]
                    q = quantity(sum(x["value"] for x in values), "m2", "derived", "mesh_contact_area", components=values) if values else None
                else:
                    q = measured.get(fallback)
            if q is None or q["value"] <= 1e-10:
                evidence.append({"element_id": part["id"], "kind": "unavailable"})
            else:
                total += q["value"]
                item = {"element_id": part["id"], **q}
                if part.get("geometry_evidence"):
                    item["geometry_evidence"] = part["geometry_evidence"]
                evidence.append(item)
        # Partial quantities must not masquerade as totals for an assembly.
        available = all(q["kind"] != "unavailable" for q in evidence)
        result[key] = quantity(total if available else 0, unit, "derived" if available else "unavailable", "sum_distinct_parts", components=evidence)
    result["count"] = quantity(len(parts), "piece", "derived", "distinct_ifc_parts", element_ids=[p["id"] for p in parts])
    return result
