//! Parameter evidence for a family-instance schedule preview, without geometry.
use rvt::{RevitFile, native_document, schema_registry};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn partition_names(file:&mut RevitFile,registry:&schema_registry::Registry)->Result<Value,String>{
    let bytes=native_document::read_single(file,"Global/PartitionTable").map_err(|e|e.to_string())?;
    if bytes.len()<6||bytes[bytes.len()-4..]!=[0;4]{return Err("Unsupported partition table footer".into())}
    let graph=rvt::native_parameters::decode_graph(&bytes[..bytes.len()-4],registry).map_err(|e|e.to_string())?;
    let root=graph.objects.first().ok_or("Partition table root missing")?;
    if root.class_name!="PartitionTable"{return Err("Unexpected partition table root".into())}
    let rows=root.fields["m_set"].as_array().ok_or("Partition table rows missing")?;
    let mut names=serde_json::Map::new();
    for (i,row) in rows.iter().enumerate(){
        let id=row["m_id"]["m_id"].as_i64().ok_or("Partition identity unavailable")?;
        if row["m_type"]!=0||row["m_deleted"]!=false{continue}
        let name=row["m_name"].as_str().ok_or("Partition name unavailable")?;
        if names.insert(id.to_string(),json!({"status":"decoded","partition_id":id,"name":name,
            "partition_type":0,"source":{"stream":"Global/PartitionTable","path":["objects",0,"fields","m_set",i],"root_class":"PartitionTable"},
            "interpretation":"saved_user_partition_name_requires_review"})).is_some(){return Err("Duplicate user partition identity".into())}
    }
    Ok(Value::Object(names))
}

pub fn extract(bytes: Vec<u8>) -> Result<Value, String> {
    super::validate_input_size(bytes.len())?;
    let mut file=RevitFile::open_bytes(bytes).map_err(|e|e.to_string())?;
    let schema=native_document::read_single(&mut file,"Formats/Latest").map_err(|e|e.to_string())?;
    let registry=schema_registry::parse(&schema).map_err(|e|e.to_string())?;
    let (worksets,workset_error)=match partition_names(&mut file,&registry){Ok(v)=>(v,None),Err(e)=>(json!({}),Some(e))};
    let mut selected:BTreeSet<String>=["FamilyInstance","FamilySymbol","RbsPipeCurve","RbsDuctCurve","RbsFlexPipeCurve","RbsFlexDuctCurve","CableTray","RbsConduitCurve","RbsPipeInsulation","RbsDuctInsulation","RbsDuctLining","RbsPipeType","AbsDuctType","AbsFlexDuctType","RbsFlexPipeType","RbsCableTrayType","RbsConduitType"].into_iter().map(str::to_string).collect();
    for class in &registry.classes {
        let mut parent=registry.class(class.parent_reference.tag);let mut seen=BTreeSet::new();
        while let Some(p)=parent {if !seen.insert(p.tag){break}if selected.contains(&p.name){selected.insert(class.name.clone());break}parent=registry.class(p.parent_reference.tag);}
    }
    let options=native_document::Options {
        selected_classes:selected,
        max_graph_values:100_000,max_graph_objects:100_000,..Default::default()
    };
    let mut records=Vec::new();let mut size=0usize;let mut clipped=0usize;
    let result=native_document::extract(&mut file,&options,|record| {
        let root=record.graph.as_ref().and_then(|g|g.objects.first());
        let root_fields:serde_json::Map<String,Value>=root.and_then(|r|r.fields.as_object()).map(|f|f.iter().filter(|(k,_)|
            matches!(k.as_str(),"m_masterSymbolId"|"m_familyId"|"m_createdPhaseId"|"m_demolishedPhaseId"|"m_designOptionId"|"m_name"|"m_categoryId"|"m_idType"|"m_idSystemCategory"))
            .map(|(k,v)|(k.clone(),v.clone())).collect()).unwrap_or_default();
        let mut row=json!({"identity":record.identity,"class_name":record.class_name,
            "status":record.status,"diagnostic":record.diagnostic,"source":record.source,
            "root_fields":root_fields,"saved_metadata":record.saved_metadata,
            "metadata_diagnostic":record.metadata_diagnostic});
        if let Some(workset)=worksets.get(record.identity.partition_id.to_string()) {row["workset"]=workset.clone();}
        // Definitions are identical project data, not per-owner values. Retain
        // them once in the summary and keep only IDs in each owner's evidence.
        if let Some(m)=row["saved_metadata"].as_object_mut() {
            for key in ["parameter_definitions"] {
                if let Some(values)=m.remove(key) {
                    m.insert(format!("{key}_ids"),json!(values.as_array().map(|a|a.iter().filter_map(|d|d.get("parameter_id").cloned()).collect::<Vec<_>>()).unwrap_or_default()));
                }
            }
        }
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
