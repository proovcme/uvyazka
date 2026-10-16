//! Addressable native data extraction. Saved fields, never evaluated API values.
use rvt::{RevitFile, native_document, schema_registry};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, io::Write, path::Path};

pub fn run(input: &str, request_path: &str, output: &str) -> Result<(), Box<dyn std::error::Error>> {
    let request: Value=serde_json::from_slice(&fs::read(request_path)?)?;
    let mode=request["mode"].as_str().unwrap_or("records");
    if mode!="inventory" && mode!="records" { return Err("Unknown extraction mode".into()); }
    let mut file=RevitFile::open(input)?;
    let schema_bytes=native_document::read_single(&mut file,"Formats/Latest")?;
    let registry=schema_registry::parse(&schema_bytes)?;
    let inventory:Vec<Value>=registry.classes.iter().map(|class|json!({
        "name":class.name,"tag":class.tag,"parent":registry.class(class.parent_reference.tag).map(|c|&c.name),
        "schema_offset":class.offset,"fields":class.fields.iter().map(|f|json!({"name":f.name,"offset":f.offset,"base":f.base,"modifier":f.modifier})).collect::<Vec<_>>()
    })).collect();
    if mode=="inventory" {
        fs::write(output,serde_json::to_vec(&json!({"schema_version":1,"schema_sha256":registry.source_sha256,"classes":inventory}))?)?;
        return Ok(());
    }
    let strings=|key:&str|->BTreeSet<String>{request[key].as_array().map(|a|a.iter().filter_map(|v|v.as_str().map(str::to_string)).collect()).unwrap_or_default()};
    let ids=request["element_ids"].as_array().map(|a|a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    let options=native_document::Options {selected_ids:ids,selected_classes:strings("classes"),max_graph_values:50000,max_graph_objects:10000,..Default::default()};
    let max_records=request["max_records"].as_u64().unwrap_or(20000).clamp(1,20000);
    let mut writer=std::io::BufWriter::new(fs::File::create(output)?);
    let mut count=0u64;let mut bytes=0usize;let mut clipped=0u64;
    let result=native_document::extract(&mut file,&options,|record|{
        if count>=max_records || bytes>=128*1024*1024 {return Err(std::io::Error::other("Uvyazka extraction output budget reached").into());}
        let mut row=serde_json::to_value(&record)?;
        let encoded=serde_json::to_vec(&row)?;
        let encoded=if encoded.len()>2*1024*1024 {
            clipped+=1;row["graph"]=Value::Null;row["saved_metadata"]=Value::Null;
            row["projection_status"]=json!("record_exceeds_2MiB");serde_json::to_vec(&row)?
        } else {encoded};
        writer.write_all(&encoded)?;writer.write_all(b"\n")?;
        count+=1;bytes+=encoded.len()+1;Ok(())
    });
    writer.flush()?;
    let (summary,error)=match result {Ok(s)=>(serde_json::to_value(s)?,None),Err(e)=>(Value::Null,Some(e.to_string()))};
    let unsupported=summary["unsupported_graph_records"].as_u64().unwrap_or(0);
    let unsupported_metadata=summary["unsupported_metadata_records"].as_u64().unwrap_or(0);
    let report=json!({"schema_version":1,"status":if error.is_none() && clipped==0 && unsupported==0 && unsupported_metadata==0 {"extracted_requires_review"}else{"partial"},
        "value_semantics":"serialized_not_evaluated","record_count":count,"output_bytes":bytes,"clipped_records":clipped,
        "error":error,"summary":summary,"schema_sha256":registry.source_sha256,"classes":inventory});
    fs::write(Path::new(output).with_extension("summary.json"),serde_json::to_vec(&report)?)?;
    Ok(())
}
