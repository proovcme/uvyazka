"""DrawingModelSpec -> standard IFC4. No inference and no project-specific shapes."""
from __future__ import annotations

import json
from pathlib import Path
import uuid

import ifcopenshell
import ifcopenshell.api.aggregate as aggregate
import ifcopenshell.api.context as context_api
import ifcopenshell.api.feature as feature
import ifcopenshell.api.geometry as geometry
import ifcopenshell.api.material as material_api
import ifcopenshell.api.project as project_api
import ifcopenshell.api.pset as pset_api
import ifcopenshell.api.root as root_api
import ifcopenshell.api.spatial as spatial
import ifcopenshell.api.style as style_api
import ifcopenshell.api.unit as unit_api
import ifcopenshell.validate
import numpy as np

from .model_spec import ModelSpec, WallGeometry, ExtrusionGeometry, MeshGeometry, OpeningGeometry, DoorGeometry, WindowGeometry

COMPILER_VERSION = "0.1.0"


def stable_guid(project_id, key):
    return ifcopenshell.guid.compress(uuid.uuid5(uuid.NAMESPACE_URL, f"ifccs:{project_id}:{key}").hex)


def compile_ifc(spec: ModelSpec, project_id: str, output: Path, source_manifest: dict):
    model = project_api.create_file(version=spec.schema_name)
    def entity(ifc_class, key, name, predefined_type=None):
        product = root_api.create_entity(model, ifc_class=ifc_class, name=name, predefined_type=predefined_type)
        if predefined_type is not None and getattr(product, "PredefinedType", None) != predefined_type:
            raise ValueError(f"{predefined_type} не является стандартным типом {ifc_class}")
        product.GlobalId = stable_guid(project_id, key)
        return product
    project = entity("IfcProject", "project", spec.name)
    site = entity("IfcSite", "site", spec.name + " · участок")
    building = entity("IfcBuilding", "building", spec.name)
    aggregate.assign_object(model, products=[site], relating_object=project)
    aggregate.assign_object(model, products=[building], relating_object=site)
    unit_api.assign_unit(model, units=[unit_api.add_si_unit(model, unit_type=kind) for kind in ("LENGTHUNIT", "AREAUNIT", "VOLUMEUNIT")])
    world = context_api.add_context(model, context_type="Model")
    body = context_api.add_context(model, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=world)
    levels, rows, placements, definitions, materials = {}, {}, {}, {e.id: e for e in spec.elements}, {}
    def provenance(product, evidence, assumptions):
        records = [{**e.model_dump(mode="json"), "source_sha256": source_manifest[e.source_id]["sha256"],
            "source_filename": source_manifest[e.source_id]['filename']} for e in evidence]
        pset = pset_api.add_pset(model, product=product, name="IFCCS_DrawingProvenance")
        pset_api.edit_pset(model, pset=pset, properties={"ProjectId": project_id, "CompilerVersion": COMPILER_VERSION,
            "InterpretationVerified": False, "EvidenceJSON": json.dumps(records, ensure_ascii=False),
            "AssumptionsJSON": json.dumps(assumptions, ensure_ascii=False), "GeometryUnit": "m"})
    pset = pset_api.add_pset(model, product=project, name='IFCCS_DrawingProject')
    pset_api.edit_pset(model, pset=pset, properties={
        'DrawingFramesJSON': json.dumps([frame.model_dump(mode='json') for frame in spec.drawing_frames], ensure_ascii=False),
        'AssumptionsJSON': json.dumps(spec.assumptions, ensure_ascii=False), 'InterpretationVerified': False})
    for level in spec.storeys:
        product = entity("IfcBuildingStorey", "storey:" + level.id, level.name)
        product.Elevation = level.elevation
        aggregate.assign_object(model, products=[product], relating_object=building)
        matrix = np.eye(4); matrix[2, 3] = level.elevation
        geometry.edit_object_placement(model, product=product, matrix=matrix)
        provenance(product, level.evidence, [])
        levels[level.id] = product
    for material in spec.materials:
        item = material_api.add_material(model, name=material.name)
        style = style_api.add_style(model, name=material.name)
        style_api.add_surface_style(model, style=style, ifc_class="IfcSurfaceStyleShading",
            attributes={"SurfaceColour": dict(zip(("Red", "Green", "Blue"), material.color)), "Transparency": 0.0})
        materials[material.id] = (item, style)
    for definition in spec.elements:
        product = entity(definition.ifc_class, definition.id, definition.name, definition.predefined_type)
        rows[definition.id] = product
        if definition.ifc_class == "IfcSpace":
            aggregate.assign_object(model, products=[product], relating_object=levels[definition.storey_id])
        elif definition.ifc_class != "IfcOpeningElement":
            spatial.assign_container(model, products=[product], relating_structure=levels[definition.storey_id])
        if definition.material_id:
            material_api.assign_material(model, products=[product], material=materials[definition.material_id][0])
        assumptions = list(definition.assumptions)
        if isinstance(definition.geometry, (DoorGeometry, WindowGeometry)):
            assumptions.append('IFCCS: schematic default lining/panel details, not fabrication geometry from the drawing')
        provenance(product, definition.evidence, assumptions)
        if definition.ifc_class == "IfcWall" and (definition.load_bearing is not None or definition.is_external is not None):
            pset = pset_api.add_pset(model, product=product, name="Pset_WallCommon")
            pset_api.edit_pset(model, pset=pset, properties={key: value for key, value in
                (("LoadBearing", definition.load_bearing), ("IsExternal", definition.is_external)) if value is not None})

    def extrusion(outer, holes, depth):
        # Arbitrary closed profile retains holes as genuine swept-area voids.
        def curve(points):
            closed = list(points) if points[0] == points[-1] else [*points, points[0]]
            return model.createIfcPolyline([model.createIfcCartesianPoint(tuple(float(x) for x in p)) for p in closed])
        profile = model.createIfcArbitraryProfileDefWithVoids("AREA", None, curve(outer), [curve(h) for h in holes]) if holes else model.createIfcArbitraryClosedProfileDef("AREA", None, curve(outer))
        solid = model.createIfcExtrudedAreaSolid(profile, model.createIfcAxis2Placement3D(model.createIfcCartesianPoint((0., 0., 0.))),
            model.createIfcDirection((0., 0., 1.)), float(depth))
        return model.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])

    def assign(definition, rep, matrix):
        product = rows[definition.id]
        geometry.assign_representation(model, product=product, representation=rep)
        geometry.edit_object_placement(model, product=product, matrix=matrix, is_si=True)
        if definition.material_id:
            style_api.assign_representation_styles(model, shape_representation=rep, styles=[materials[definition.material_id][1]])
        placements[definition.id] = matrix

    for definition in spec.elements:
        geom = definition.geometry
        matrix = np.eye(4); matrix[2, 3] = levels[definition.storey_id].Elevation
        if isinstance(geom, WallGeometry):
            x = np.asarray(geom.end) - geom.start; length = np.linalg.norm(x); x /= length
            matrix[:2, 0] = x; matrix[:2, 1] = [-x[1], x[0]]
            matrix[:2, 3] = geom.start; matrix[2, 3] += geom.base_offset
            # Coordinates refer to the first wall face, not an implicit centreline.
            rep = geometry.add_wall_representation(model, context=body, length=float(length), height=geom.height, thickness=geom.thickness)
        elif isinstance(geom, ExtrusionGeometry):
            matrix[:3, 0] = geom.x_axis; matrix[:3, 2] = geom.z_axis; matrix[:3, 1] = np.cross(geom.z_axis, geom.x_axis)
            matrix[:3, 3] += geom.origin
            rep = extrusion(geom.outer, geom.holes, geom.depth)
        elif isinstance(geom, MeshGeometry):
            rep = geometry.add_mesh_representation(model, context=body, vertices=[geom.vertices], faces=[geom.triangles], unit_scale=1)
        else:
            continue
        assign(definition, rep, matrix)
    for definition in spec.elements:
        geom = definition.geometry
        if not isinstance(geom, OpeningGeometry):
            continue
        host = definitions[geom.host_id].geometry
        translation = np.eye(4); translation[:3, 3] = (geom.offset, -geom.margin, geom.sill)
        matrix = placements[geom.host_id] @ translation
        rep = extrusion([(0, 0), (geom.width, 0), (geom.width, host.thickness + 2 * geom.margin), (0, host.thickness + 2 * geom.margin)], [], geom.height)
        assign(definition, rep, matrix)
        feature.add_feature(model, feature=rows[definition.id], element=rows[geom.host_id])
    for definition in spec.elements:
        geom = definition.geometry
        if not isinstance(geom, (DoorGeometry, WindowGeometry)):
            continue
        opening = definitions[geom.opening_id].geometry
        matrix = placements[geom.opening_id].copy(); matrix[:3, 3] += matrix[:3, 1] * opening.margin
        product = rows[definition.id]; product.OverallWidth = opening.width; product.OverallHeight = opening.height
        if isinstance(geom, DoorGeometry):
            rep = geometry.add_door_representation(model, context=body, overall_width=opening.width, overall_height=opening.height, operation_type=geom.operation_type, unit_scale=1)
        else:
            rep = geometry.add_window_representation(model, context=body, overall_width=opening.width, overall_height=opening.height, unit_scale=1)
        assign(definition, rep, matrix)
        feature.add_filling(model, opening=rows[geom.opening_id], element=product)
    model.header.file_name.name = output.name
    model.header.file_name.originating_system = "IFCCS Drawing Generator " + COMPILER_VERSION
    # Validate the saved and re-opened file, including EXPRESS where rules.
    model.write(str(output))
    reopened = ifcopenshell.open(str(output))
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(reopened, logger, express_rules=True)
    statements = [{"level": item.get("level"), "message": str(item.get("message")),
        "instance": str(item.get("instance", ""))[:1000]} for item in logger.statements]
    errors = [item for item in statements if str(item["level"]).lower() == "error"]
    if errors:
        raise ValueError("Ошибка IFC: " + errors[0]["message"][:2000])
    return {"schema": reopened.schema_identifier, "element_count": len(spec.elements),
        "element_map": {key: {"global_id": product.GlobalId, "step_id": product.id()} for key, product in rows.items()},
        "express_errors": errors, "diagnostics": statements, "interpretation_verified": False, "compiler_version": COMPILER_VERSION}
