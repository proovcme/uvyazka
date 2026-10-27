//! Per-model source namespaces stay separate inside a federated NWD.
use crate::{
    Container,
    fragments::{Fragments, read_fragments_in},
    geometry::{MeshDefinition, read_geometry_in},
    metadata::{LogicalModel, read_logical_models},
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
pub fn read_scene(c: &Container) -> Scene {
    let mut metadata: BTreeMap<_, _> = read_logical_models(c)
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
        match c
            .blocks
            .iter()
            .find(|b| b.entry.name == format!("{namespace}\\LcOpNwdGeometry"))
        {
            Some(block) => match read_geometry_in(block) {
                Ok(g) => model.geometry = g,
                Err(e) => model.diagnostics.push(e),
            },
            None => model.diagnostics.push("Geometry stream absent".into()),
        }
        match c
            .blocks
            .iter()
            .find(|b| b.entry.name == format!("{namespace}\\LcOpNwdFragments"))
        {
            Some(block) => match read_fragments_in(block, &model.geometry) {
                Ok(f) => {
                    model.geometry_complete = f.decoded == f.declared
                        && f.diagnostic.is_none()
                        && f.rows
                            .iter()
                            .all(|r| r.local_bounds_match && r.primitive_count_matches)
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
