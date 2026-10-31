//! Shared native parameter projection used by the browser and the MCP reader. Apache-2.0.
use rvt::{RevitFile,native_document,schema_registry};
use serde_json::{Value,json};
use std::collections::BTreeSet;

pub fn partition_names(file:&mut RevitFile,registry:&schema_registry::Registry)->Result<Value,String>{
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


pub fn parameter_classes(registry:&schema_registry::Registry)->BTreeSet<String>{
    let mut selected:BTreeSet<String>=["FamilyInstance","FamilySymbol","RbsPipeCurve","RbsDuctCurve","RbsFlexPipeCurve","RbsFlexDuctCurve","CableTray","RbsConduitCurve","RbsPipeInsulation","RbsDuctInsulation","RbsDuctLining","RbsPipeType","AbsDuctType","AbsFlexDuctType","RbsFlexPipeType","RbsCableTrayType","RbsConduitType","RbsPipeInsulationType","RbsDuctInsulationType","RbsDuctLiningType"].into_iter().map(str::to_string).collect();
    for class in &registry.classes {
        let mut parent=registry.class(class.parent_reference.tag);let mut seen=BTreeSet::new();
        while let Some(p)=parent {if !seen.insert(p.tag){break}if selected.contains(&p.name){selected.insert(class.name.clone());break}parent=registry.class(p.parent_reference.tag);}
    }
    selected
}

pub fn compact(record:&native_document::Record,worksets:&Value)->Value{
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
    row
}
