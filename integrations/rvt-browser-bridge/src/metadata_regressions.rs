//! Synthetic graph regressions; no source project values or IDs.
use rvt::{native_metadata, native_parameter_definitions::{Definition,Registry}, native_parameters::{GraphObject,GraphEdge,ObjectGraph}};
use serde_json::{json,Value};
use std::collections::BTreeMap;

fn object(name:&str,fields:Value)->GraphObject {
    GraphObject{class_tag:12,class_name:name.into(),token:0,start:0,fields_end:0,fields}
}
fn graph(name:&str)->ObjectGraph {
    ObjectGraph{consumed_bytes:0,objects:vec![object(name,json!({}))],edges:vec![]}
}
#[test]
fn mep_categories_are_explicit_class_projections_and_unknowns_stay_unknown(){
    for (class,id) in [("RbsDuctCurve",-2008000),("RbsFlexDuctCurve",-2008020),("RbsPipeCurve",-2008044),("RbsFlexPipeCurve",-2008050),("RbsPipeInsulation",-2008122),("RbsDuctInsulation",-2008123),("RbsDuctLining",-2008124),("CableTray",-2008130),("RbsConduitCurve",-2008132)]{
        let saved=native_metadata::project(&graph(class)).unwrap();
        for pid in [-1140362,-1140363]{let p=saved.raw_field_parameters.iter().find(|p|p.parameter_id==pid).unwrap();assert_eq!(p.raw_value,json!(id));assert_eq!(p.source_field,"@schema_class");assert_eq!(p.projection_rule,"qualified_mep_class_to_builtin_category");}
    }
    assert!(native_metadata::project(&graph("FamilyInstance")).unwrap().raw_field_parameters.is_empty());
    assert!(native_metadata::project(&graph("FakeRbsDuctCurve")).unwrap().raw_field_parameters.is_empty());
}
fn definition()->Definition{
    Definition{parameter_id:71,source_object:0,definition_class:"ParamDefString".into(),owner_class:"ParamElem".into(),caption:"Synthetic label".into(),type_id:None,spec_type_id:None,group_type_id:None,spec_evidence:"synthetic",unit_type_id:None,unit_format_fields:None,unit_resolution:"not_applicable".into(),shared_guid:None,is_shared:None,storage_type:Some("String".into()),storage_evidence:"synthetic",definition_fields:json!({}),owner_fields:BTreeMap::new()}
}
#[test]
fn duplicate_representations_preserve_equal_and_conflicting_values_without_losing_owner(){
    for slot in ["same","different"]{
        let mut g=graph("FamilyInstance");
        g.objects[0].fields=json!({"m_masterSymbolId":5,"m_pParamValueSetAString":{"pointer_token":1,"offset":10},"m_pInstParams":{"pointer_token":2,"offset":20}});
        g.objects.push(object("ParamValueSetAString",json!({"m_paramSet":[{"m_paramId":71,"m_value":"same"},{"m_paramId":72,"m_value":"other field"}]})));
        g.objects.push(object("FamilyParams",json!({"m_params":[{"m_paramId":71,"m_instance":true,"m_reporting":false,"m_value":0.0,"m_int":0,"m_str":slot,"m_elemId":-1,"m_oExpression":{"pointer_token":0}}]})));
        for (offset,target) in [(10,1),(20,2)]{g.edges.push(GraphEdge{source_object_index:0,pointer_offset:offset,pointer_token:target as u32,target_object_index:target,target_class_tag:12});}
        let mut registry=Registry::default();registry.definitions.insert(71,definition());
        let saved=native_metadata::project_with_definitions(&g,&registry).unwrap();
        assert_eq!(saved.parameter_sets[0].parameters.len(),2);
        assert_eq!(saved.parameter_sets[0].parameters[0].raw_value,"same");
        assert_eq!(saved.resolved_family_parameters[0].raw_value,slot);
        assert_eq!(saved.declared_custom_parameters[0].has_value_evidence,"present_owner_typed_parameter_and_family_slot");
        assert!(!saved.complete_element_metadata);
    }
}

#[test]
fn analytical_length_requires_exact_owner_route_and_finite_line_data(){
    let mut g=graph("RbsPipeCurve");g.objects[0].fields=json!({"m_idType":44,"m_pCurveDriver":{"pointer_token":1,"offset":10}});
    g.objects.push(object("RbsCurveDriver",json!({"m_pCrv":{"pointer_token":2,"offset":20}})));
    g.objects.push(object("GLine",json!({"m_dirVec":[0,2,0],"m_endParams":[7,2]})));
    for (source,offset,target) in [(0,10,1),(1,20,2)]{g.edges.push(GraphEdge{source_object_index:source,pointer_offset:offset,pointer_token:target as u32,target_object_index:target,target_class_tag:12});}
    let p=native_metadata::project(&g).unwrap();
    let length=p.raw_field_parameters.iter().find(|p|p.parameter_id == -1004005).unwrap();assert_eq!(length.raw_value,json!(10.0));assert_eq!(length.projection_rule,"derived_saved_line_length_feet");assert_eq!(length.source_object,2);
    assert_eq!(p.raw_field_parameters.iter().find(|p|p.parameter_id == -1002052).unwrap().raw_value,44);
    g.objects[2].class_name="GArc".into();assert!(!native_metadata::project(&g).unwrap().raw_field_parameters.iter().any(|p|p.parameter_id == -1004005));
    g.objects[2].class_name="GLine".into();g.objects[2].fields["m_dirVec"]=json!([0,0,0]);assert!(!native_metadata::project(&g).unwrap().raw_field_parameters.iter().any(|p|p.parameter_id == -1004005));
    g.objects[2].fields["m_dirVec"]=json!([1,0,0]);g.edges.pop();assert!(!native_metadata::project(&g).unwrap().raw_field_parameters.iter().any(|p|p.parameter_id == -1004005));
}
