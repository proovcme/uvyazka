//! Selected document records, independent of geometry conversion.
use rvt::{RevitFile, native_document, schema_registry};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn kind(name: &str, parents: &BTreeMap<String, String>) -> Option<&'static str> {
    let mut current = name;
    let mut seen = BTreeSet::new();
    while seen.insert(current) {
        match current {
            "TableView" => return Some("schedule"),
            "DBView" => return Some("view"),
            "Viewport" | "ScheduleInstanceBase" => return Some("placement"),
            _ => current = parents.get(current)?.as_str(),
        }
    }
    None
}

pub fn extract_document(bytes: Vec<u8>) -> Result<Value, String> {
    super::validate_input_size(bytes.len())?;
    let mut file = RevitFile::open_bytes(bytes).map_err(|e|e.to_string())?;
    let schema = native_document::read_single(&mut file, "Formats/Latest").map_err(|e|e.to_string())?;
    let registry = schema_registry::parse(&schema).map_err(|e|e.to_string())?;
    let parents:BTreeMap<String,String> = registry.classes.iter().filter_map(|c|
        registry.class(c.parent_reference.tag).map(|p|(c.name.clone(),p.name.clone()))).collect();
    let kinds:BTreeMap<String,&str> = registry.classes.iter().filter_map(|c|
        kind(&c.name,&parents).map(|k|(c.name.clone(),k))).collect();
    // An empty class selector means all records to the native reader. Never
    // accidentally turn a missing schema into a whole-document extraction.
    if kinds.is_empty() {return Err("No supported view/table classes in this schema".into());}
    let options = native_document::Options {selected_classes:kinds.keys().cloned().collect(),
        max_graph_values:1_000_000,max_graph_objects:20_000,..Default::default()};
    let mut records=Vec::new();let mut output_bytes=0usize;let mut clipped=0;
    let result=native_document::extract_graphs(&mut file,&options,|record| {
        let mut row=serde_json::to_value(&record)?;
        row["kind"]=json!(record.class_name.as_ref().and_then(|c|kinds.get(c)));
        // Parameters are available through the native MCP; this projection
        // needs the explicit view/table graph, not duplicate parameter sets.
        row.as_object_mut().unwrap().remove("saved_metadata");
        let size=serde_json::to_vec(&row)?.len();
        if output_bytes+size>64*1024*1024 {
            row["graph"]=Value::Null;row["status"]=json!("output_budget_exceeded");
            row["diagnostic"]=json!("Browser document output exceeded 64 MiB; record graph omitted");clipped+=1;
        } else {output_bytes+=size;}
        records.push(row);Ok(())
    });
    let (summary,error)=match result {Ok(s)=>(serde_json::to_value(s).map_err(|e|e.to_string())?,None),Err(e)=>(Value::Null,Some(e.to_string()))};
    Ok(json!({"schema_version":1,"schema_sha256":registry.source_sha256,"records":records,
        "summary":summary,"error":error,"clipped_records":clipped,
        "status":if error.is_some()||clipped>0||summary["unsupported_graph_records"].as_u64().unwrap_or(0)>0 {"partial"}else{"extracted_requires_review"},
        "value_semantics":"serialized_not_evaluated","evaluated_schedule_body_available":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classification_follows_ancestry_not_substrings() {
        let parents=BTreeMap::from([("DBViewSchedule".into(),"TableView".into()),("TableView".into(),"DBView".into()),("DBView3d".into(),"DBView".into()),("ScheduleInstance".into(),"ScheduleInstanceBase".into())]);
        assert_eq!(kind("DBViewSchedule",&parents),Some("schedule"));
        assert_eq!(kind("DBView3d",&parents),Some("view"));
        assert_eq!(kind("ScheduleInstance",&parents),Some("placement"));
        assert_eq!(kind("FakeSchedule",&parents),None);
        assert!(extract_document(b"bad".to_vec()).is_err());
    }
}
