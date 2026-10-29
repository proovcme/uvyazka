//! Saved RVT graphics to a viewer buffer. No IFC exporter, entities or STEP.
use rvt::{RevitFile, native_document, native_saved_scene::SavedScene};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const FEET_TO_M: f64 = 0.3048;
const MAX_BINARY: usize = 512 * 1024 * 1024;

#[derive(Serialize)]
pub struct DirectScene {
    pub manifest: Value,
    #[serde(serialize_with = "binary")]
    pub geometry_binary: Vec<u8>,
}
fn binary<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_bytes(bytes)
}
// Native identities and parameter references must survive the JS boundary.
fn exact_numbers(value: &mut Value) {
    match value {
        Value::Number(n)
            if n.as_u64().is_some_and(|v| v > 9_007_199_254_740_991)
                || n.as_i64().is_some_and(|v| v < -9_007_199_254_740_991) =>
        {
            *value = Value::String(n.to_string());
        }
        Value::Array(rows) => rows.iter_mut().for_each(exact_numbers),
        Value::Object(fields) => fields.values_mut().for_each(exact_numbers),
        _ => {}
    }
}
fn graphics_resource(name: &str, parents: &BTreeMap<String, String>) -> bool {
    let mut current = name;
    let mut seen = BTreeSet::new();
    while seen.insert(current) {
        if matches!(
            current,
            "FamilySymbol" | "ElementType" | "GuideGrid" | "DBView" | "Sketch" | "SketchPlane"
        ) {
            return true;
        }
        match parents.get(current) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    false
}

pub fn extract(bytes: Vec<u8>) -> Result<DirectScene, String> {
    super::validate_input_size(bytes.len())?;
    let mut file = RevitFile::open_bytes(bytes).map_err(|e| e.to_string())?;
    let options = native_document::Options::default();
    let mut scene =
        rvt::native_saved_scene::extract(&mut file, &options).map_err(|e| e.to_string())?;
    let ids = scene
        .elements
        .iter()
        .filter(|e| e.meshes.primitives.iter().any(|p| !p.triangles.is_empty()))
        .map(|e| e.identity.element_id)
        .collect::<BTreeSet<_>>();
    if ids.is_empty() {
        return Err("RVT direct: no saved graphics owners decoded".into());
    }
    let metadata_options = native_document::Options {
        selected_ids: ids,
        ..options
    };
    let mut metadata = BTreeMap::new();
    let mut definitions = BTreeMap::new();
    let mut metadata_bytes = 0usize;
    let result = native_document::extract(&mut file, &metadata_options, |record| {
        let fields = record
            .graph
            .as_ref()
            .and_then(|g| g.objects.first())
            .map(|o| &o.fields);
        let root_fields: serde_json::Map<String, Value> = fields
            .and_then(Value::as_object)
            .map(|f| {
                f.iter()
                    .filter(|(k, _)| {
                        matches!(
                            k.as_str(),
                            "m_name"
                                | "m_categoryId"
                                | "m_levelId"
                                | "m_masterSymbolId"
                                | "m_idType"
                                | "m_createdPhaseId"
                                | "m_demolishedPhaseId"
                        )
                    })
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut row = json!({"class_name":record.class_name,"source":record.source,
            "root_fields":root_fields,"status":record.status,"saved_metadata":record.saved_metadata,
            "diagnostic":record.diagnostic,"metadata_diagnostic":record.metadata_diagnostic});
        if let Some(m) = row["saved_metadata"].as_object_mut() {
            for key in ["parameter_definitions", "builtin_parameter_definitions"] {
                if let Some(Value::Array(values)) = m.remove(key) {
                    let mut keys = Vec::new();
                    for d in values {
                        let id = d["parameter_id"].to_string();
                        keys.push(Value::String(id.clone()));
                        definitions.entry(id).or_insert(d);
                    }
                    m.insert(format!("{key}_ids"), Value::Array(keys));
                }
            }
        }
        metadata_bytes += serde_json::to_vec(&row)?.len();
        if metadata_bytes > 64 * 1024 * 1024 {
            row["saved_metadata"] = Value::Null;
            row["status"] = json!("metadata_output_budget_exceeded");
        }
        metadata.insert(record.identity.element_id.to_string(), row);
        Ok(())
    });
    let metadata_error = result.err().map(|e| e.to_string());
    let schema =
        native_document::read_single(&mut file, "Formats/Latest").map_err(|e| e.to_string())?;
    let registry = rvt::schema_registry::parse(&schema).map_err(|e| e.to_string())?;
    let parents = registry
        .classes
        .iter()
        .filter_map(|c| {
            registry
                .class(c.parent_reference.tag)
                .map(|p| (c.name.clone(), p.name.clone()))
        })
        .collect();
    let observed = scene.elements.len();
    let mut resources = 0;
    scene.elements.retain(|e| {
        let is_resource = metadata
            .get(&e.identity.element_id.to_string())
            .and_then(|m| m["class_name"].as_str())
            .is_some_and(|name| graphics_resource(name, &parents));
        if is_resource {
            resources += 1;
        }
        !is_resource
    });
    let mut result = pack(scene, metadata, definitions, metadata_error, MAX_BINARY)?;
    result.manifest["observed_records"] = json!(observed);
    result.manifest["unrendered_records"] =
        json!(observed - result.manifest["elements"].as_array().unwrap().len());
    result.manifest["excluded_graphics_resources"] = json!(resources);
    Ok(result)
}

fn pack(
    scene: SavedScene,
    metadata: BTreeMap<String, Value>,
    definitions: BTreeMap<String, Value>,
    metadata_error: Option<String>,
    budget: usize,
) -> Result<DirectScene, String> {
    let observed_records = scene.elements.len();
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    let mut total = 0usize;
    let mut ids = BTreeSet::new();
    for element in &scene.elements {
        if !ids.insert(element.identity.element_id) {
            return Err("RVT direct: duplicate graphics owner".into());
        }
        for primitive in &element.meshes.primitives {
            if primitive.vertices.iter().flatten().any(|x| !x.is_finite())
                || primitive
                    .triangles
                    .iter()
                    .flatten()
                    .any(|i| *i as usize >= primitive.vertices.len())
            {
                return Err("RVT direct: invalid native mesh coordinates or indices".into());
            }
            if primitive.triangles.is_empty() {
                continue;
            }
            total = total
                .checked_add(
                    primitive
                        .vertices
                        .len()
                        .checked_mul(12)
                        .ok_or("Mesh size overflow")?,
                )
                .and_then(|n| n.checked_add(primitive.triangles.len().checked_mul(12)?))
                .ok_or("Mesh size overflow")?;
            if total > budget {
                return Err("RVT direct: geometry exceeds 512 MiB output budget".into());
            }
            for point in &primitive.vertices {
                for axis in 0..3 {
                    let x = point[axis] * FEET_TO_M;
                    if !x.is_finite() {
                        return Err("RVT direct: invalid metre coordinates".into());
                    }
                    minimum[axis] = minimum[axis].min(x);
                    maximum[axis] = maximum[axis].max(x);
                }
            }
        }
    }
    if total == 0 {
        return Err(
            "RVT direct: usable saved graphics not decoded; no IFC fallback was used".into(),
        );
    }
    let origin = std::array::from_fn::<_, 3, _>(|i| minimum[i] / 2.0 + maximum[i] / 2.0);
    let mut bytes = Vec::with_capacity(total);
    let mut elements = Vec::new();
    for element in scene.elements {
        // The index also contains project settings, types and non-3D records.
        // An absent saved surface is not proof of a missing physical element.
        if !element
            .meshes
            .primitives
            .iter()
            .any(|p| !p.triangles.is_empty())
        {
            continue;
        }
        let id = element.identity.element_id.to_string();
        let mut positions = Vec::<[f32; 3]>::new();
        let mut indices = Vec::<u32>::new();
        let mut groups = Vec::new();
        let mut styles = Vec::new();
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for (pi, p) in element.meshes.primitives.iter().enumerate() {
            if p.triangles.is_empty() {
                continue;
            }
            let base =
                u32::try_from(positions.len()).map_err(|_| "RVT direct: vertex index budget")?;
            let start = indices.len();
            for v in &p.vertices {
                let world = v.map(|x| x * FEET_TO_M);
                let local = std::array::from_fn::<_, 3, _>(|i| (world[i] - origin[i]) as f32);
                if local.iter().any(|x| !x.is_finite()) {
                    return Err("RVT direct: Float32 range exceeded".into());
                }
                for i in 0..3 {
                    low[i] = low[i].min(world[i]);
                    high[i] = high[i].max(world[i]);
                }
                positions.push(local);
            }
            for t in &p.triangles {
                for i in t {
                    indices.push(base.checked_add(*i).ok_or("RVT direct: index overflow")?);
                }
            }
            let material = element.render_materials.get(&pi);
            let color = material
                .map(|m| m.base_color)
                .unwrap_or([0.58, 0.64, 0.70, 1.0]);
            styles.push(json!({"name":material.map(|m| m.name.as_str()).unwrap_or("Материал не прочитан"),"color":[color[0],color[1],color[2]],"opacity":color[3]}));
            groups.push(
                json!({"start":start,"count":indices.len()-start,"material_index":styles.len()-1}),
            );
        }
        let mesh = if indices.is_empty() {
            Value::Null
        } else {
            let po = bytes.len();
            for p in &positions {
                for v in p {
                    bytes.extend(v.to_le_bytes());
                }
            }
            let io = bytes.len();
            for i in &indices {
                bytes.extend(i.to_le_bytes());
            }
            json!({"bbox_min_m":low,"bbox_max_m":high,"position_byte_offset":po,"index_byte_offset":io,
                "vertex_count":positions.len(),"index_count":indices.len(),"representation_id":0,"groups":groups,"styles":styles,
                "source":{"kind":"derived","method":"rvt_native_saved_graphics","version":"1","representation_id":0}})
        };
        elements.push(json!({"element_id":id,"unique_id":element.identity.unique_id,"source":element.source,
            "material_evidence":element.render_materials,"referenced_graph_sources":element.referenced_graph_sources,
            "status":element.status,"metadata":metadata.get(&id),"mesh":mesh,
            "unresolved_material_primitives":element.unresolved_material_primitives,
            "diagnostics":element.meshes.diagnostics,"unbounded_faces":element.meshes.unbounded_faces,
            "excluded_visibility_branches":element.meshes.excluded_visibility_branches,
            "excluded_non_surface_branches":element.meshes.excluded_non_surface_branches}));
    }
    let unrendered_records = observed_records - elements.len();
    let mut manifest = json!({"contract":"RvtDirectScene","version":1,"experimental":true,
        "observed_records":observed_records,"unrendered_records":unrendered_records,
        "revit_version":scene.summaries.first().map(|s| s.revit_version),"units":"metres","original_units":"feet",
        "complete_document_geometry":false,"graphics_profile":scene.graphics_profile,
        "bounds_min_m":minimum,"bounds_max_m":maximum,"render_origin_m":origin,
        "elements":elements,"metadata_error":metadata_error,"parameter_definitions":definitions,"summaries":scene.summaries});
    exact_numbers(&mut manifest);
    Ok(DirectScene {
        manifest,
        geometry_binary: bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scene() -> SavedScene {
        let identity = rvt::native_index::Identity {
            element_id: 9_007_199_254_740_993,
            original_id_suffix: 1,
            creation_episode: 0,
            stored_revision: 0,
            other_revision: 0,
            row_offset: 0,
            raw_fields: vec![],
            owning_element_id: 0,
            partition_id: 0,
            unique_id: "synthetic-unique-id".into(),
        };
        let p = rvt::native_saved_mesh::Primitive {
            source_owner_id: None,
            object_index: 0,
            face_tag: 0,
            render_style_id: 0,
            material_id: None,
            vertices: vec![[1000., 0., 0.], [1001., 0., 0.], [1000., 1., 0.]],
            normals: vec![],
            triangles: vec![[0, 1, 2]],
        };
        SavedScene {
            source_sha256: None,
            format: "synthetic",
            units: "feet",
            coordinate_frame: "document Z-up",
            complete_document_geometry: false,
            detail_level: 3,
            graphics_profile: "synthetic",
            summaries: vec![],
            elements: vec![rvt::native_saved_scene::SavedElement {
                id: identity.element_id,
                identity,
                source: json!({}),
                referenced_graph_sources: BTreeMap::new(),
                status: "decoded_saved_graphics".into(),
                meshes: rvt::native_saved_mesh::GraphicsMeshes {
                    primitives: vec![p],
                    ..Default::default()
                },
                render_materials: BTreeMap::new(),
                unresolved_material_primitives: vec![0],
            }],
        }
    }
    #[test]
    fn packs_exact_id_metres_and_binary_ranges() {
        let result = pack(scene(), BTreeMap::new(), BTreeMap::new(), None, 1024).unwrap();
        assert_eq!(
            result.manifest["elements"][0]["element_id"],
            "9007199254740993"
        );
        assert_eq!(result.geometry_binary.len(), 48);
        assert_eq!(
            result.manifest["elements"][0]["mesh"]["index_byte_offset"],
            36
        );
        assert!((result.manifest["bounds_min_m"][0].as_f64().unwrap() - 304.8).abs() < 1e-9);
        assert_eq!(result.manifest["complete_document_geometry"], false);
    }
    #[test]
    fn rejects_corruption_empty_and_budget_without_ifc_fallback() {
        let mut bad = scene();
        bad.elements[0].meshes.primitives[0].triangles[0][2] = 99;
        assert!(pack(bad, BTreeMap::new(), BTreeMap::new(), None, 1024).is_err());
        assert!(pack(scene(), BTreeMap::new(), BTreeMap::new(), None, 1).is_err());
        let mut empty = scene();
        empty.elements.clear();
        assert!(pack(empty, BTreeMap::new(), BTreeMap::new(), None, 1024).is_err());
        assert!(extract(b"not RVT".to_vec()).is_err());
    }
    #[test]
    fn nondrawable_index_records_are_coverage_not_missing_physical_elements() {
        let mut s = scene();
        let mut extra = scene().elements.pop().unwrap();
        extra.identity.element_id = 42;
        extra.meshes.primitives.clear();
        s.elements.push(extra);
        let result = pack(s, BTreeMap::new(), BTreeMap::new(), None, 1024).unwrap();
        assert_eq!(result.manifest["observed_records"], 2);
        assert_eq!(result.manifest["unrendered_records"], 1);
        assert_eq!(result.manifest["elements"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn graphics_resources_use_declared_ancestry_not_name_guesses() {
        let parents = BTreeMap::from([("SyntheticSymbol".into(), "FamilySymbol".into())]);
        assert!(graphics_resource("SyntheticSymbol", &parents));
        assert!(graphics_resource("GuideGrid", &parents));
        assert!(!graphics_resource("UnknownType", &parents));
        assert!(!graphics_resource("FamilyInstance", &parents));
    }
}
