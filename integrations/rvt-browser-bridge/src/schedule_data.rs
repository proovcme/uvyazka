//! Parameter evidence for a family-instance schedule preview, without geometry.
use rvt::{RevitFile, native_document, schema_registry};
use serde_json::{Value, json};

#[path="../../rvt-shared/metadata_projection.rs"]
mod projection;

pub fn extract(bytes: Vec<u8>) -> Result<Value, String> {
    super::validate_input_size(bytes.len())?;
    let mut file=RevitFile::open_bytes(bytes).map_err(|e|e.to_string())?;
    let schema=native_document::read_single(&mut file,"Formats/Latest").map_err(|e|e.to_string())?;
    let registry=schema_registry::parse(&schema).map_err(|e|e.to_string())?;
    let (worksets,workset_error)=match projection::partition_names(&mut file,&registry){Ok(v)=>(v,None),Err(e)=>(json!({}),Some(e))};
    let selected=projection::parameter_classes(&registry);
    let options=native_document::Options {
        selected_classes:selected,
        max_graph_values:1_000_000,max_graph_objects:100_000,..Default::default()
    };
    let mut records=Vec::new();let mut size=0usize;let mut clipped=0usize;
    let result=native_document::extract(&mut file,&options,|record| {
        let mut row=projection::compact(&record,&worksets);
        let n=serde_json::to_vec(&row)?.len();
        if size+n>128*1024*1024 {row["saved_metadata"]=Value::Null;row["status"]=json!("output_budget_exceeded");clipped+=1;}else{size+=n;}
        records.push(row);Ok(())
    });
    let (summary,error)=match result {Ok(s)=>(serde_json::to_value(s).map_err(|e|e.to_string())?,None),Err(e)=>(Value::Null,Some(e.to_string()))};
    Ok(json!({"schema_version":2,"scope":options.selected_classes,"records":records,
        "summary":summary,"error":error,"clipped_records":clipped,"workset_error":workset_error,
        "status":if error.is_some()||clipped>0||summary["unsupported_metadata_records"].as_u64().unwrap_or(0)>0||summary["unsupported_graph_records"].as_u64().unwrap_or(0)>0 {"partial"}else{"extracted_requires_review"},
        "value_semantics":"serialized_not_evaluated","complete_project_inventory":false}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn invalid_container_never_becomes_empty_success() {
        assert!(super::extract(b"not rvt".to_vec()).is_err());
    }
}
