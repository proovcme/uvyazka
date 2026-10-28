//! Per-model source namespaces stay separate inside a federated NWD.
use crate::{
    Container,
    fragments::{Fragments, read_fragments_in},
    geometry::{MeshDefinition, read_geometry_in},
    metadata::{LogicalModel, read_logical_models_with_progress},
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize)]
pub struct SourceModel {
    pub namespace: String,
    pub geometry: Vec<MeshDefinition>,
    pub fragments: Option<Fragments>,
    pub logical_model: Option<LogicalModel>,
    pub diagnostics: Vec<String>,
    pub geometry_complete: bool,
}
#[derive(Debug, Serialize)]
pub struct Scene {
    pub models: Vec<SourceModel>,
    pub complete_file_support: bool,
    pub unsupported_features: Vec<&'static str>,
}
/// Serialize the borrowed report directly instead of duplicating the entire
/// decoded scene into an intermediate JSON value (particularly costly in WASM).
#[derive(Serialize)]
pub struct SceneReport<'a> {
    pub container: &'a Container,
    #[serde(flatten)]
    pub scene: Scene,
}
#[derive(Serialize)]
pub struct PackedGeometry {
    pub position_byte_offset: usize,
    pub vertex_count: usize,
    pub triangle_byte_offset: usize,
    pub triangle_index_count: usize,
    pub line_byte_offset: usize,
    pub line_index_count: usize,
}
/// Browser geometry is binary, never millions of decimal strings and JS objects.
/// The native CLI retains the full inspectable report.
pub fn pack_geometry(scene: &mut Scene) -> (Vec<u8>, Vec<Vec<PackedGeometry>>) {
    pack_geometry_limit(scene, crate::MAX_EXPANDED)
}
fn pack_geometry_limit(scene: &mut Scene, budget: usize) -> (Vec<u8>, Vec<Vec<PackedGeometry>>) {
    let mut bytes = Vec::new();
    let mut sources = Vec::new();
    for source in &mut scene.models {
        let mut entries = Vec::new();
        for g in &mut source.geometry {
            let required = g.definition.positions.len() as u64 * 12
                + g.triangles.len() as u64 * 12
                + g.lines.len() as u64 * 8;
            if bytes.len() as u64 + required > budget as u64 {
                g.definition.positions.clear();
                g.triangles.clear();
                g.lines.clear();
                g.diagnostic = Some(
                    "Browser geometry transfer budget exceeded; source metadata retained".into(),
                );
                source.geometry_complete = false;
            }
            let position_byte_offset = bytes.len();
            let vertex_count = g.definition.positions.len();
            for p in std::mem::take(&mut g.definition.positions) {
                for v in p {
                    bytes.extend(v.to_le_bytes())
                }
            }
            let triangle_byte_offset = bytes.len();
            let triangle_index_count = g.triangles.len() * 3;
            for p in std::mem::take(&mut g.triangles) {
                for v in p {
                    bytes.extend(v.to_le_bytes())
                }
            }
            let line_byte_offset = bytes.len();
            let line_index_count = g.lines.len() * 2;
            for p in std::mem::take(&mut g.lines) {
                for v in p {
                    bytes.extend(v.to_le_bytes())
                }
            }
            g.indices.clear();
            g.strips.clear();
            entries.push(PackedGeometry {
                position_byte_offset,
                vertex_count,
                triangle_byte_offset,
                triangle_index_count,
                line_byte_offset,
                line_index_count,
            });
        }
        sources.push(entries)
    }
    (bytes, sources)
}
pub fn read_scene(c: &Container) -> Scene {
    read_scene_with_progress(c, &mut |_| {})
}
pub fn read_scene_with_progress(c: &Container, phase: &mut dyn FnMut(&str)) -> Scene {
    phase("Исходное дерево и страницы свойств NWD");
    let mut metadata: BTreeMap<_, _> = read_logical_models_with_progress(c, phase)
        .into_iter()
        .map(|m| (m.namespace.clone(), m))
        .collect();
    let mut namespaces: BTreeSet<String> = metadata.keys().cloned().collect();
    for block in &c.blocks {
        if let Some(namespace) = block.entry.name.strip_suffix("\\LcOpNwdGeometry") {
            namespaces.insert(namespace.to_owned());
        }
    }
    let mut models = vec![];
    for namespace in namespaces {
        let mut model = SourceModel {
            namespace: namespace.clone(),
            geometry: vec![],
            fragments: None,
            logical_model: metadata.remove(&namespace),
            diagnostics: vec![],
            geometry_complete: false,
        };
        phase("Топология и определения геометрии NWD");
        match c
            .blocks
            .iter()
            .find(|b| b.entry.name == format!("{namespace}\\LcOpNwdGeometry"))
        {
            Some(block) => {
                match read_geometry_in(block) {
                    Ok(g) => {
                        let unread = g.iter().filter(|g| g.diagnostic.is_some()).count();
                        for record in g.iter().filter(|g| g.diagnostic.is_some()).take(100) {
                            model.diagnostics.push(format!(
                                "Geometry slot {} at {}: {}",
                                record.definition.index,
                                record.definition.record_offset,
                                record.diagnostic.as_deref().unwrap()
                            ));
                        }
                        if unread > 100 {
                            model.diagnostics.push(format!("{} further geometry records unavailable; per-record errors retained",unread-100));
                        }
                        model.geometry = g;
                    }
                    Err(e) => model.diagnostics.push(e),
                }
            }
            None => model.diagnostics.push("Geometry stream absent".into()),
        }
        phase("Размещения и сверка фрагментов NWD");
        match c
            .blocks
            .iter()
            .find(|b| b.entry.name == format!("{namespace}\\LcOpNwdFragments"))
        {
            Some(block) => match read_fragments_in(block, &model.geometry) {
                Ok(f) => {
                    for asset in &f.assets {
                        if let Some(error) = asset.value["diagnostic"].as_str() {
                            model.diagnostics.push(format!(
                                "Appearance asset {} at {}: {error}",
                                asset.serialized_id, asset.record_offset
                            ));
                        }
                    }
                    model.geometry_complete = f.decoded == f.declared
                        && f.diagnostic.is_none()
                        && f.rows.iter().all(|r| {
                            r.diagnostic.is_none()
                                && r.local_bounds_match
                                && r.primitive_count_matches
                        })
                        && model.geometry.iter().all(|g| g.diagnostic.is_none());
                    model.fragments = Some(f);
                }
                Err(e) => model.diagnostics.push(e),
            },
            None => model.diagnostics.push("Fragment stream absent".into()),
        }
        models.push(model);
    }
    Scene {
        models,
        complete_file_support: false,
        unsupported_features: vec![
            "saved viewpoints",
            "clash results",
            "TimeLiner",
            "rendered textures",
            "all serialization variants",
        ],
    }
}

#[cfg(test)]
mod packing_tests {
    use super::*;
    use crate::fixtures::*;
    #[test]
    fn packed_geometry_is_little_endian_bounded_and_keeps_source_metadata() {
        let c = crate::read_container(&scene(geometry_record(), fragment_record())).unwrap();
        let mut s = read_scene(&c);
        let (b, p) = pack_geometry(&mut s);
        assert_eq!(p[0][0].vertex_count, 3);
        assert_eq!(p[0][0].triangle_index_count, 3);
        assert_eq!(p[0][0].triangle_byte_offset, 36);
        assert_eq!(b.len(), 48);
        assert_eq!(
            &b[36..],
            &[0u32.to_le_bytes(), 1u32.to_le_bytes(), 2u32.to_le_bytes()].concat()
        );
        assert!(s.models[0].geometry[0].definition.positions.is_empty());
        assert_eq!(s.models[0].fragments.as_ref().unwrap().decoded, 1);
        let mut s = read_scene(&c);
        let (b, p) = pack_geometry_limit(&mut s, 0);
        assert!(b.is_empty());
        assert_eq!(p[0][0].vertex_count, 0);
        assert!(
            s.models[0].geometry[0]
                .diagnostic
                .as_deref()
                .unwrap()
                .contains("budget")
        );
        assert!(!s.models[0].geometry_complete);
    }
}
