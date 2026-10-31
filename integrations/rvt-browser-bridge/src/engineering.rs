//! Project existing typed MEP graphs without losing the base-equipment role.
use rvt::{RevitFile};
use rvt::research::{native_document, partition_mep_systems};
use serde_json::{Value,json};

pub fn extract(bytes:Vec<u8>)->Result<Value,String>{
    super::validate_input_size(bytes.len())?;
    let mut file=RevitFile::open_bytes(bytes).map_err(|e|e.to_string())?;
    let options=native_document::Options{selected_classes:partition_mep_systems::SYSTEM_CLASSES.iter().map(|s|s.to_string()).collect(),max_graph_values:100_000,max_graph_objects:20_000,..Default::default()};
    let mut systems=Vec::new();let mut diagnostics=Vec::new();
    let result=native_document::extract_graphs(&mut file,&options,|record|{
        match record.graph.as_ref().ok_or_else(||"System graph unavailable".to_string()).and_then(|g|partition_mep_systems::project_system(record.identity.element_id,g).map_err(|e|e.to_string())){
            Ok(system)=>systems.push(json!({"system":system,"source":record.source})),
            Err(error)=>diagnostics.push(format!("system {}: {error}",record.identity.element_id)),
        }Ok(())
    });
    match result{
        Ok(summary)=>{
            if !partition_mep_systems::supports_revit_version(summary.revit_version){return Ok(json!({"status":"unsupported_version","systems":[],"diagnostics":[format!("MEP graph projection is not validated for {}",summary.revit_version)]}));}
            if !summary.selected_ids_without_records.is_empty(){diagnostics.push(format!("{} selected records unavailable",summary.selected_ids_without_records.len()));}
            Ok(json!({"status":if diagnostics.is_empty(){"extracted_requires_review"}else{"partial"},"systems":systems,"diagnostics":diagnostics,"revit_version":summary.revit_version}))
        },
        Err(error)=>{diagnostics.push(error.to_string());Ok(json!({"status":"partial","systems":[],"diagnostics":diagnostics}))}
    }
}

#[cfg(test)]
mod tests{
    #[test]
    fn invalid_input_fails_closed(){assert!(super::extract(vec![]).is_err());assert!(super::extract(b"bad".to_vec()).is_err());}
}
