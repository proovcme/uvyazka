//! Parameter evidence for a family-instance schedule preview, without geometry.
use rvt::{RevitFile, native_document};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn extract(bytes: Vec<u8>) -> Result<Value, String> {
    super::validate_input_size(bytes.len())?;
    let mut file=RevitFile::open_bytes(bytes).map_err(|e|e.to_string())?;
    let options=native_document::Options {
        selected_classes:BTreeSet::from(["FamilyInstance".into(),"FamilySymbol".into()]),
        max_graph_values:100_000,max_graph_objects:20_000,..Default::default()
    };
    let mut records=Vec::new();let mut size=0usize;let mut clipped=0usize;
    let result=native_document::extract(&mut file,&options,|record| {
        let root=record.graph.as_ref().and_then(|g|g.objects.first());
        let root_fields:serde_json::Map<String,Value>=root.and_then(|r|r.fields.as_object()).map(|f|f.iter().filter(|(k,_)|
            matches!(k.as_str(),"m_masterSymbolId"|"m_familyId"|"m_createdPhaseId"|"m_demolishedPhaseId"|"m_designOptionId"|"m_name"|"m_categoryId"))
            .map(|(k,v)|(k.clone(),v.clone())).collect()).unwrap_or_default();
        let mut row=json!({"identity":record.identity,"class_name":record.class_name,
            "status":record.status,"diagnostic":record.diagnostic,"source":record.source,
            "root_fields":root_fields,"saved_metadata":record.saved_metadata,
            "metadata_diagnostic":record.metadata_diagnostic});
        let n=serde_json::to_vec(&row)?.len();
        if size+n>64*1024*1024 {row["saved_metadata"]=Value::Null;row["status"]=json!("output_budget_exceeded");clipped+=1;}else{size+=n;}
        records.push(row);Ok(())
    });
    let (summary,error)=match result {Ok(s)=>(serde_json::to_value(s).map_err(|e|e.to_string())?,None),Err(e)=>(Value::Null,Some(e.to_string()))};
    Ok(json!({"schema_version":1,"scope":["FamilyInstance","FamilySymbol"],"records":records,
        "summary":summary,"error":error,"clipped_records":clipped,
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
