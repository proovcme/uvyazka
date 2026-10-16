//! Uvyazka patch: MEP names and membership from current native object graphs.
//! No byte-pattern membership or first-printable-string fallback is used.
use crate::native_parameters::ObjectGraph;
use crate::{RevitFile, native_document};
use anyhow::{Result, ensure};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

pub const SYSTEM_CLASSES: [&str; 3] = ["RbsHvacSystem", "RbsPipingSystem", "RbsElectricalSystem"];
pub const UNNAMED_CIRCUIT: &str = "<unnamed>";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemberEvidence {
    pub element_id: u32,
    pub object_index: usize,
    pub field: String,
    pub entry_index: usize,
    pub connection_type: u64,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MepSystem {
    pub id: u32,
    pub class: String,
    pub name: Option<String>,
    pub name_field: String,
    pub saved_name: String,
    pub members: BTreeSet<u32>,
    pub member_evidence: Vec<MemberEvidence>,
}

#[derive(Debug, Default, Serialize)]
pub struct MepReport {
    pub systems: Vec<MepSystem>,
    pub diagnostics: Vec<String>,
    pub selected_records: usize,
}

pub fn supports_revit_version(version: u32) -> bool {
    (2024..=2027).contains(&version)
}

fn id(value: &Value) -> Option<u32> {
    let value = value.get("m_id")?.get("m_id64")?.as_u64()?;
    u32::try_from(value).ok().filter(|id| *id > 0)
}

/// Resolve a field by its explicit edge, including pointer token/class checks.
fn target(graph: &ObjectGraph, owner: usize, pointer: &Value) -> Result<Option<usize>> {
    let token = pointer["pointer_token"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("missing pointer token"))?;
    let offset = pointer["offset"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("missing pointer offset"))?;
    let edges: Vec<_> = graph
        .edges
        .iter()
        .filter(|e| e.source_object_index == owner && e.pointer_offset as u64 == offset)
        .collect();
    if token == 0 {
        ensure!(edges.is_empty(), "null pointer has a graph edge");
        return Ok(None);
    }
    ensure!(
        edges.len() == 1,
        "pointer must have exactly one explicit edge"
    );
    let edge = edges[0];
    let object = graph
        .objects
        .get(edge.target_object_index)
        .ok_or_else(|| anyhow::anyhow!("edge target outside graph"))?;
    ensure!(
        edge.pointer_token as u64 == token && edge.target_class_tag == object.class_tag,
        "edge token/class mismatch"
    );
    Ok(Some(edge.target_object_index))
}

fn references(
    system: &mut MepSystem,
    graph: &ObjectGraph,
    index: usize,
    field: &str,
    connector: bool,
) -> Result<()> {
    let values = graph.objects[index].fields[field]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing {field} array"))?;
    for (entry_index, reference) in values.iter().enumerate() {
        let kind = reference["m_connType"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("missing connection type"))?;
        let member = id(&reference["m_id"]);
        if member.is_none() && reference["m_id"]["m_id"]["m_id64"].as_i64() == Some(-1) {
            continue;
        }
        let member =
            member.ok_or_else(|| anyhow::anyhow!("invalid or unrepresentable member ElementId"))?;
        ensure!(
            kind == 1 || (connector && kind == 4 && system.class == "RbsElectricalSystem"),
            "unsupported system reference type {kind}"
        );
        ensure!(member != system.id, "system references itself as a member");
        system.members.insert(member);
        system.member_evidence.push(MemberEvidence {
            element_id: member,
            object_index: index,
            field: field.into(),
            entry_index,
            connection_type: kind,
            role: if kind == 4 {
                "base_equipment_reference"
            } else {
                "network_member"
            }
            .into(),
        });
    }
    Ok(())
}

/// Project one complete bounded graph. Saved values are not recalculated.
pub fn project_system(element_id: u64, graph: &ObjectGraph) -> Result<MepSystem> {
    let root = graph
        .objects
        .first()
        .ok_or_else(|| anyhow::anyhow!("empty system graph"))?;
    ensure!(
        SYSTEM_CLASSES.contains(&root.class_name.as_str()),
        "unsupported system class"
    );
    let system_id = u32::try_from(element_id)?;
    ensure!(
        id(&root.fields["m_id"]) == Some(system_id),
        "system root identity mismatch"
    );
    let field = if root.class_name == "RbsElectricalSystem" {
        "m_number"
    } else {
        "m_strName"
    };
    let saved_name = root.fields[field]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing {field} string"))?;
    let name = if saved_name.is_empty() && root.class_name == "RbsElectricalSystem" {
        UNNAMED_CIRCUIT
    } else {
        saved_name
    };
    let mut system = MepSystem {
        id: system_id,
        class: root.class_name.clone(),
        name: Some(name.into()),
        name_field: field.into(),
        saved_name: saved_name.into(),
        members: BTreeSet::new(),
        member_evidence: Vec::new(),
    };
    if let Some(manager) = target(graph, 0, &root.fields["m_pConnectorMgr"])? {
        let object = &graph.objects[manager];
        ensure!(
            object.class_name == "RbsSystemConnectorManager",
            "unexpected system connector manager"
        );
        let pointers = object.fields["m_connPtrArray"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("missing system connector array"))?;
        for pointer in pointers {
            let index = target(graph, manager, pointer)?
                .ok_or_else(|| anyhow::anyhow!("null system connector"))?;
            ensure!(
                graph.objects[index].class_name == "Connector",
                "unexpected connector class"
            );
            references(&mut system, graph, index, "m_arrRefs", true)?;
        }
    }
    let sections = root.fields["m_rgSections"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing system section array"))?;
    for pointer in sections {
        let index =
            target(graph, 0, pointer)?.ok_or_else(|| anyhow::anyhow!("null system section"))?;
        let section = &graph.objects[index];
        ensure!(
            matches!(
                section.class_name.as_str(),
                "RbsDuctSection" | "RbsPipeSection"
            ),
            "unsupported system section class"
        );
        if let Some(ids) = section.fields.get("m_rgNetworkSegmentIds") {
            ensure!(
                ids.as_array().is_some_and(|a| a.is_empty()),
                "network segment IDs require a separate decoder"
            );
        }
        references(&mut system, graph, index, "m_rgSection", false)?;
    }
    Ok(system)
}

/// Read current system records once; preserve successful systems and report gaps.
pub fn scan_mep_systems_report(
    rf: &mut RevitFile,
    version: u32,
    elements: &BTreeSet<u32>,
) -> Result<MepReport> {
    ensure!(
        supports_revit_version(version),
        "unvalidated MEP graph version {version}"
    );
    let options = native_document::Options {
        selected_classes: SYSTEM_CLASSES.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    };
    let mut report = MepReport::default();
    let summary = native_document::extract_graphs(rf, &options, |record| {
        report.selected_records += 1;
        let result = record
            .graph
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("system graph unavailable"))
            .and_then(|g| project_system(record.identity.element_id, g));
        match result {
            Ok(mut system) => {
                system.members.retain(|member| elements.contains(member));
                system
                    .member_evidence
                    .retain(|e| elements.contains(&e.element_id));
                report.systems.push(system);
            }
            Err(error) => report
                .diagnostics
                .push(format!("system {}: {error}", record.identity.element_id)),
        }
        Ok(())
    })?;
    if !summary.selected_ids_without_records.is_empty() {
        report.diagnostics.push(format!(
            "{} selected system records are unavailable",
            summary.selected_ids_without_records.len()
        ));
    }
    Ok(report)
}

/// Compatibility entrypoint: callers cannot silently accept incomplete membership.
pub fn scan_mep_systems(
    rf: &mut RevitFile,
    version: u32,
    elements: &BTreeSet<u32>,
) -> Result<Vec<MepSystem>> {
    let report = scan_mep_systems_report(rf, version, elements)?;
    ensure!(
        report.diagnostics.is_empty(),
        "incomplete MEP system extraction: {}",
        report.diagnostics.join("; ")
    );
    Ok(report.systems)
}
