//! Addressable, paged extraction. Saved fields, never evaluated API values.
use rvt::{RevitFile, native_document, schema_registry};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, io::Write, path::Path};
#[path="../../rvt-shared/metadata_projection.rs"]
mod projection;

pub fn run(input: &str, request_path: &str, output: &str) -> Result<(), Box<dyn std::error::Error>> {
    let request:Value=serde_json::from_slice(&fs::read(request_path)?)?;
    let mode=request["mode"].as_str().unwrap_or("records");
    if mode!="inventory" && mode!="records" {return Err("Unknown extraction mode".into());}
    let mut file=RevitFile::open(input)?;
    let schema_bytes=native_document::read_single(&mut file,"Formats/Latest")?;
    let registry=schema_registry::parse(&schema_bytes)?;
    let parameters=projection::parameter_classes(&registry);
    let inventory:Vec<Value>=registry.classes.iter().map(|class|json!({
        "name":class.name,"tag":class.tag,"parent":registry.class(class.parent_reference.tag).map(|c|&c.name),
        "table_parameter":parameters.contains(&class.name),"schema_offset":class.offset,
        "fields":class.fields.iter().map(|f|json!({"name":f.name,"offset":f.offset,"base":f.base,"modifier":f.modifier})).collect::<Vec<_>>()
    })).collect();
    if mode=="inventory" {fs::write(output,serde_json::to_vec(&json!({"schema_version":2,"schema_sha256":registry.source_sha256,"classes":inventory}))?)?;return Ok(());}
    let strings=|key:&str|->BTreeSet<String>{request[key].as_array().map(|a|a.iter().filter_map(|v|v.as_str().map(str::to_string)).collect()).unwrap_or_default()};
    let ids=request["element_ids"].as_array().map(|a|a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    let compact=request["projection"]=="compact";let graphs=request["projection"]=="graphs";
    let (worksets,workset_error)=if compact {match projection::partition_names(&mut file,&registry){Ok(v)=>(v,None),Err(e)=>(json!({}),Some(e))}} else {(json!({}),None)};
    let options=native_document::Options{selected_ids:ids,selected_classes:strings("classes"),max_graph_values:1_000_000,max_graph_objects:if graphs{20_000}else{100_000},..Default::default()};
    let offset=request["offset"].as_u64().unwrap_or(0);
    let max_records=request["max_records"].as_u64().unwrap_or(20000).clamp(1,20000);
    let page_bytes=request["page_bytes"].as_u64().unwrap_or(128*1024*1024).clamp(1024,128*1024*1024) as usize;
    let mut writer=std::io::BufWriter::new(fs::File::create(output)?);
    let (mut count,mut bytes,mut clipped,mut mep_errors,mut observed,mut full)=(0u64,0usize,0u64,0u64,0u64,false);
    let mut emit=|record:native_document::Record|->anyhow::Result<()> {
        let index=observed;observed+=1;
        if index<offset||full{return Ok(());}
        let parameter=compact&&record.class_name.as_ref().is_some_and(|c|parameters.contains(c));
        let mut row=if parameter{projection::compact(&record,&worksets)}else{serde_json::to_value(&record)?};
        if graphs {row.as_object_mut().unwrap().remove("saved_metadata");}
        if record.class_name.as_deref().is_some_and(|c|rvt::partition_mep_systems::SYSTEM_CLASSES.contains(&c)) {
            let projected=record.graph.as_ref().ok_or("system graph unavailable".to_string()).and_then(|g|rvt::partition_mep_systems::project_system(record.identity.element_id,g).map_err(|e|e.to_string()));
            match projected{Ok(s)=>row["mep_system"]=serde_json::to_value(s)?,Err(e)=>{mep_errors+=1;row["mep_system_diagnostic"]=json!(e);}}
        }
        let mut encoded=serde_json::to_vec(&row)?;
        if encoded.len()>32*1024*1024 {
            clipped+=1;row["graph"]=Value::Null;row["saved_metadata"]=Value::Null;
            row["projection_status"]=json!("record_exceeds_32MiB");encoded=serde_json::to_vec(&row)?;
        }
        // A single record may exceed the soft page target. Emit it once so
        // continuation always advances; the independent hard record cap remains.
        if count>0&&(count>=max_records||bytes+encoded.len()+1>page_bytes){full=true;return Ok(());}
        writer.write_all(&encoded)?;writer.write_all(b"\n")?;count+=1;bytes+=encoded.len()+1;Ok(())
    };
    let result=if graphs{native_document::extract_graphs(&mut file,&options,&mut emit)}else{native_document::extract(&mut file,&options,&mut emit)};
    writer.flush()?;
    if offset>observed{return Err("Native page offset exceeds the selected inventory".into());}
    let (summary,error)=match result{Ok(s)=>(serde_json::to_value(s)?,None),Err(e)=>(Value::Null,Some(e.to_string()))};
    let unsupported=summary["unsupported_graph_records"].as_u64().unwrap_or(0);
    let metadata=if graphs{0}else{summary["unsupported_metadata_records"].as_u64().unwrap_or(0)};
    let report=json!({"schema_version":2,"status":if error.is_none()&&clipped==0&&unsupported==0&&metadata==0&&mep_errors==0{"extracted_requires_review"}else{"partial"},
        "value_semantics":"serialized_not_evaluated","record_count":count,"output_bytes":bytes,"clipped_records":clipped,"error":error,"workset_error":workset_error,
        "mep_projection_errors":mep_errors,"summary":summary,"schema_sha256":registry.source_sha256,"classes":inventory,
        "pagination":{"offset":offset,"returned":count,"next_offset":if full{Some(offset+count)}else{None},"selected_record_count":observed}});
    fs::write(Path::new(output).with_extension("summary.json"),serde_json::to_vec(&report)?)?;Ok(())
}
