"""Read-only IFC -> versioned ModelPackage. Runs independently of the viewer."""
from __future__ import annotations

from collections import Counter, deque
import hashlib
import json
import math
from pathlib import Path
import time
from typing import Any

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as elements
import ifcopenshell.util.placement as placements
import ifcopenshell.util.unit as units
import numpy as np
from .quantities import explicit_quantities, mesh_quantities, source_quantity_values

IMPORTER_VERSION = "0.4.3"
CONTRACT_VERSION = "0.1.0"
IDENTITY_VERSION = "ifc-revit-tag-1"


def identity_metadata(product, exporter):
    tag=getattr(product,'Tag',None)
    result={'tag':str(tag) if tag is not None else None,'long_name':getattr(product,'LongName',None)}
    if tag is not None and str(tag).isdigit() and ('revit' in exporter.lower() or 'rvt-rs' in exporter.lower()):
        result['revit']={'element_id':str(tag),'phase_status':'unavailable',
            'id_basis':'rvt_converter_tag' if 'rvt-rs' in exporter.lower() else 'ifc_tag_revit_export'}
    return result


def write_json(path: Path, value: Any):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    # Windows may briefly deny replacement while an HTTP polling thread reads the file.
    for attempt in range(12):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 11:
                raise
            time.sleep(0.01)


def jsonable(value):
    if isinstance(value, ifcopenshell.entity_instance):
        return {"step_id": value.id(), "class": value.is_a()} if value.id() else jsonable(value.wrappedValue)
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [jsonable(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def hierarchy(schema, class_name):
    result = []
    declaration = schema.declaration_by_name(class_name)
    while declaration:
        result.append(declaration.name())
        declaration = declaration.supertype()
    return result


def spatial_index(model):
    """Find storeys through rooms, assemblies and hosts, without guessing by elevation."""
    parents: dict[int, list[int]] = {}
    relationships = []
    for class_name, parent_key, child_key in (
        ("IfcRelContainedInSpatialStructure", "RelatingStructure", "RelatedElements"),
        ("IfcRelAggregates", "RelatingObject", "RelatedObjects"),
        ("IfcRelNests", "RelatingObject", "RelatedObjects"),
        ("IfcRelVoidsElement", "RelatingBuildingElement", "RelatedOpeningElement"),
        ("IfcRelFillsElement", "RelatingOpeningElement", "RelatedBuildingElement"),
    ):
        for relation in model.by_type(class_name):
            parent = getattr(relation, parent_key)
            children = getattr(relation, child_key)
            children = children if isinstance(children, tuple) else (children,)
            relationships.append({"step_id": relation.id(), "class": relation.is_a(),
                "parent_id": str(parent.id()), "child_ids": [str(child.id()) for child in children]})
            for child in children:
                parents.setdefault(child.id(), []).append(parent.id())
    storeys = {storey.id() for storey in model.by_type("IfcBuildingStorey")}

    def resolve(entity):
        queue = deque([entity.id()])
        visited = set()
        while queue:
            current = queue.popleft()
            if current in visited:
                continue
            visited.add(current)
            if current in storeys:
                return str(current)
            queue.extend(parents.get(current, ()))
        return None

    return resolve, relationships


def style_data(style):
    diffuse = style.diffuse
    color = [diffuse.r(), diffuse.g(), diffuse.b()]
    if not all(math.isfinite(component) for component in color):
        color = [0.68, 0.71, 0.73]
    transparency = float(style.transparency)
    return {"name": style.name, "color": [max(0, min(1, component)) for component in color],
        "opacity": max(0.08, min(1, 1 - transparency)) if math.isfinite(transparency) else 1}


def geometry_evidence(psets, exporter):
    """Fail closed for experimental converter bodies, including separately uploaded IFC."""
    carrier = next((values for name, values in psets.items() if name == "RvtElementRecordGeometry"), {})
    if not carrier and "rvt-rs" not in exporter.lower():
        return None
    body = carrier.get("BodySource")
    # A newly introduced source needs review before it can provide a takeoff.
    decoded = {"partition_wall_centreline", "partition_wall_centreline_layer_joins", "partition_wall_arc",
        "partition_wall_tapered_section", "partition_beam_axis", "partition_pipe_axis",
        "partition_stair_run_sketch", "partition_roof_slope", "family_type_i_section", "saved_graphics_mesh"}
    resolved_profile = body == "partition_element_record_bbox" and carrier.get("ProfileResolved") is True
    allowed = body in decoded or resolved_profile
    return {"engine": "rvt-rs", "body_source": body, "profile_resolved": carrier.get("ProfileResolved"),
        "status": "decoded_approximation" if allowed else "bounding_box" if body and ("box" in body or "bbox" in body) else "unknown",
        "quantity_eligible": allowed, "requires_review": True,
        "reason": "Геометрия восстановлена экспериментальным RVT-декодером" if allowed else "Габаритный блок или неизвестное происхождение тела: объём и площадь работ недоступны"}


def import_model(source_path: str, output_path: str, source_name: str | None = None, complete_progress=True):
    source, output = Path(source_path), Path(output_path)
    output.mkdir(parents=True, exist_ok=True)
    progress = output / "progress.json"
    write_json(progress, {"status": "running", "message": "Чтение структуры IFC", "processed": 0, "total": 0})
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    model = ifcopenshell.open(str(source))
    schema = ifcopenshell.ifcopenshell_wrapper.schema_by_name(model.schema_identifier)
    projects = model.by_type("IfcProject")
    # IfcOpenShell 0.8.5 and 0.9.0.post1 silently fall back to unit factor 1
    # when an IFC4 has both IfcProject and IfcProjectLibrary (multiple contexts).
    # Reading UnitsInContext in Python does not configure the geometry kernel.
    # Refuse this native path instead of mislabelling millimetres as metres.
    contexts = projects if model.schema == 'IFC2X3' else model.by_type('IfcContext')
    if len(projects) != 1 or len(contexts) != 1:
        raise ValueError('Неоднозначный контекст единиц геометрического движка: нужен один IfcProject без дополнительных IfcContext/IfcProjectLibrary. Масштаб native-геометрии не подтверждён; используйте браузерный импорт или отдельный согласованный IFC.')
    if not projects or not projects[0].UnitsInContext or not any(getattr(unit, "UnitType", None) == "LENGTHUNIT" for unit in projects[0].UnitsInContext.Units):
        raise ValueError("В IFC не определены единицы длины проекта. Масштаб модели нельзя установить достоверно.")
    scale = units.calculate_unit_scale(model)
    resolve_storey, relationships = spatial_index(model)
    products = sorted(model.by_type("IfcProduct"), key=lambda item: item.id())
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, True)
    settings.set("mesher-linear-deflection", 0.001)
    rows, raw_meshes, diagnostics = [], [], []
    class_hierarchies = {}
    for index, product in enumerate(products):
        name = product.is_a()
        if name not in class_hierarchies:
            class_hierarchies[name] = hierarchy(schema, name)
        chain = class_hierarchies[name]
        role = ("space" if "IfcSpace" in chain else "feature" if "IfcFeatureElement" in chain else
                "element" if "IfcElement" in chain else "spatial" if "IfcSpatialStructureElement" in chain or "IfcSpatialElement" in chain else "other")
        row = {"id": str(product.id()), "step_id": product.id(), "global_id": product.GlobalId,
            "class": name, "hierarchy": chain, "name": product.Name or name, "long_name": getattr(product,'LongName',None),
            "role": role, "storey_id": resolve_storey(product),
            "predefined_type": elements.get_predefined_type(product),
            "materials": [material.Name or "Без названия" for material in elements.get_materials(product) if material is not None],
            "property_sets": jsonable(elements.get_psets(product, psets_only=True)),
            "quantity_sets": jsonable(elements.get_psets(product, qtos_only=True)),
            "quantities": explicit_quantities(product, model), "source_quantities": source_quantity_values(product,model), "measured_quantities": {},
            "source": {"kind": "explicit", "file_sha256": digest, "step_id": product.id()},
            "mesh": None, "geometry_error": None}
        evidence = geometry_evidence(row["property_sets"], model.header.file_name.preprocessor_version or "")
        if evidence:
            row["geometry_evidence"] = evidence
        row.update(identity_metadata(product,' '.join(filter(None,[model.header.file_name.preprocessor_version,model.header.file_name.originating_system]))))
        if product.Representation:
            representations = product.Representation.Representations
            selected = next((r for r in representations if r.RepresentationIdentifier == "Body"), None)
            if selected is None:
                selected = next((r for r in representations if r.RepresentationIdentifier not in ("Axis", "Plan", "FootPrint", "Box") and r.ContextOfItems.ContextType == "Model"), None)
            if selected:
                try:
                    shape = ifcopenshell.geom.create_shape(settings, product, selected)
                    geometry = shape.geometry
                    vertices = np.asarray(geometry.verts, dtype=np.float64).reshape(-1, 3)
                    faces = np.asarray(geometry.faces, dtype=np.uint32).reshape(-1, 3)
                    if not len(vertices) or not len(faces) or not np.isfinite(vertices).all():
                        raise ValueError("Не получен конечный треугольный меш")
                    styles = [style_data(style) for style in geometry.materials]
                    if not styles:
                        styles = [{"name": "Нейтральный материал просмотра", "color": [0.68, 0.71, 0.73], "opacity": 1}]
                    material_ids = np.asarray(geometry.material_ids, dtype=int)
                    if len(material_ids) != len(faces):
                        material_ids = np.zeros(len(faces), dtype=int)
                    material_ids = np.clip(material_ids, 0, len(styles) - 1)
                    order = np.argsort(material_ids, kind="stable")
                    faces = faces[order]
                    row["measured_quantities"] = mesh_quantities(vertices, faces)
                    if 'IfcFlowSegment' in chain and len(vertices) >= 4:
                        # This is a geometric estimate, not the stored Revit centreline.
                        _, _, axes = np.linalg.svd(vertices - vertices.mean(axis=0), full_matrices=False)
                        spans = np.ptp(vertices @ axes.T, axis=0)
                        if spans[0] > 2 * max(spans[1:]) and spans[0] > 0:
                            from .quantities import quantity
                            row['measured_quantities']['length'] = quantity(spans[0], 'm', 'derived',
                                'mesh_principal_span_not_centerline', review_note='Предварительная длина прямого участка по мешу; не осевая длина Revit')
                    groups, cursor = [], 0
                    for material_id, count in sorted(Counter(material_ids).items()):
                        groups.append({"start": cursor, "count": count * 3, "material_index": int(material_id)})
                        cursor += count * 3
                    row["mesh"] = {"bbox_min_m": vertices.min(axis=0).tolist(),
                        "bbox_max_m": vertices.max(axis=0).tolist(), "representation_id": selected.id(),
                        "vertex_count": len(vertices), "index_count": len(faces) * 3,
                        "styles": styles, "groups": groups,
                        "source": {"kind": "derived", "method": "ifcopenshell_body_tessellation",
                                   "version": ifcopenshell.version, "representation_id": selected.id()}}
                    raw_meshes.append((row, vertices, faces))
                except Exception as error:
                    row["geometry_error"] = str(error)[:1000]
                    diagnostics.append({"element_id": row["id"], "kind": "geometry", "message": row["geometry_error"]})
            else:
                row["geometry_error"] = "Нет объёмного представления Body или другого представления Model"
                diagnostics.append({"element_id": row["id"], "kind": "representation", "message": row["geometry_error"]})
        rows.append(row)
        if index % 10 == 0 or index == len(products) - 1:
            write_json(progress, {"status": "running", "message": "Извлечение геометрии и свойств", "processed": index + 1, "total": len(products)})
    physical = [row for row in rows if row["mesh"] and row["role"] == "element"]
    bounded = physical or [row for row in rows if row["mesh"]]
    if not bounded:
        raise ValueError("В IFC не удалось получить ни одного треугольного меша. Структура прочитана, но 3D-просмотр невозможен.")
    lower = np.min([row["mesh"]["bbox_min_m"] for row in bounded], axis=0)
    upper = np.max([row["mesh"]["bbox_max_m"] for row in bounded], axis=0)
    origin = np.array([(lower[0] + upper[0]) / 2, (lower[1] + upper[1]) / 2, lower[2]])
    # Recenter in double precision before casting to GPU float32 (large map coordinates).
    binary_path = output / "geometry.bin"
    with binary_path.open("wb") as binary:
        for row, vertices, faces in raw_meshes:
            row["mesh"]["position_byte_offset"] = binary.tell()
            binary.write(np.asarray(vertices - origin, dtype="<f4").tobytes())
            row["mesh"]["index_byte_offset"] = binary.tell()
            binary.write(np.asarray(faces, dtype="<u4").tobytes())
    storeys = []
    for storey in model.by_type("IfcBuildingStorey"):
        location = placements.get_local_placement(storey.ObjectPlacement)[:3, 3] * scale if storey.ObjectPlacement else None
        storeys.append({"id": str(storey.id()), "name": storey.Name or "Уровень без названия",
            "elevation_m": storey.Elevation * scale if storey.Elevation is not None else None,
            "placement_origin_m": location.tolist() if location is not None else None,
            "element_count": sum(row["storey_id"] == str(storey.id()) and row["role"] == "element" for row in rows)})
    storeys.sort(key=lambda row: (row["elevation_m"] or 0, row["id"]))
    result = {"contract": "ModelPackage", "contract_version": CONTRACT_VERSION, "importer_version": IMPORTER_VERSION, "identity_projection_version":IDENTITY_VERSION,
        "model_id": digest, "source": {"filename": source_name or source.name, "sha256": digest,
        "size_bytes": source.stat().st_size, "schema": model.schema_identifier,
        "exported_at": model.header.file_name.time_stamp, "exporter": model.header.file_name.preprocessor_version},
        "coordinate_system": {"length_to_m": scale, "render_origin_m": origin.tolist(),
                              "up_axis": "Z", "bounds_min_m": lower.tolist(), "bounds_max_m": upper.tolist()},
        "storeys": storeys, "elements": rows, "relationships": relationships, "diagnostics": diagnostics,
        "statistics": {"products": len(rows), "physical_elements": sum(row["role"] == "element" for row in rows),
                       "meshes": len(raw_meshes), "triangles": sum(len(faces) for _, _, faces in raw_meshes),
                       "geometry_errors": len(diagnostics), "binary_bytes": binary_path.stat().st_size},
        "capabilities": {"read": True, "geometry_ready": True, "technology_resolved": False, "schedule_ready": False}}
    write_json(output / "manifest.json", result)
    if complete_progress:
        write_json(progress, {"status": "completed", "processed": len(rows), "total": len(rows), "message": "Модель готова"})
    return {"model_id": digest, "statistics": result["statistics"]}
