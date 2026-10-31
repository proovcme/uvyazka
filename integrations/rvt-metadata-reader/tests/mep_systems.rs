use rvt::research::native_parameters::ObjectGraph;
use rvt::research::partition_mep_systems::project_system;
use serde_json::{Value, json};

fn eid(id: u64) -> Value {
    json!({"m_id":{"m_id64":id}})
}
fn pointer(offset: usize, token: u32) -> Value {
    json!({"offset":offset,"pointer_token":token})
}
fn object(tag: u16, name: &str, fields: Value) -> Value {
    json!({"class_tag":tag,"class_name":name,"token":0,"start":0,"fields_end":0,"fields":fields})
}
fn edge(owner: usize, offset: usize, token: u32, target: usize, tag: u16) -> Value {
    json!({"source_object_index":owner,"pointer_offset":offset,"pointer_token":token,"target_object_index":target,"target_class_tag":tag})
}
fn fixture() -> Value {
    json!({"consumed_bytes":100,"objects":[
        object(1,"RbsElectricalSystem",json!({"m_id":eid(1200),"m_number":"ЩР-1 / гр. 3","m_pConnectorMgr":pointer(10,3),"m_rgSections":[]})),
        object(2,"RbsSystemConnectorManager",json!({"m_connPtrArray":[pointer(20,4)]})),
        object(3,"Connector",json!({"m_arrRefs":[{"m_id":eid(101),"m_connType":1},{"m_id":eid(102),"m_connType":4}]})),
        // An unreferenced object and a coincidental ID in arbitrary fields
        // must never become a system member.
        object(3,"Connector",json!({"m_arrRefs":[{"m_id":eid(999),"m_connType":1}],"noise":1200}))
    ],"edges":[edge(0,10,3,1,2),edge(1,20,4,2,3)]})
}
fn project(value: Value) -> Result<rvt::research::partition_mep_systems::MepSystem, String> {
    let graph: ObjectGraph = serde_json::from_value(value).unwrap();
    project_system(1200, &graph).map_err(|e| e.to_string())
}

#[test]
fn unicode_names_and_base_equipment_have_exact_evidence() {
    let system = project(fixture()).unwrap();
    assert_eq!(system.name.as_deref(), Some("ЩР-1 / гр. 3"));
    assert_eq!(
        system.members.into_iter().collect::<Vec<_>>(),
        vec![101, 102]
    );
    assert_eq!(system.member_evidence[1].role, "base_equipment_reference");
    assert_eq!(system.member_evidence[1].object_index, 2);
}

#[test]
fn hvac_unicode_and_section_members_are_read_through_edges() {
    let mut f = fixture();
    f["objects"][0]["class_name"] = json!("RbsHvacSystem");
    f["objects"][0]["fields"]["m_strName"] = json!("Приточная вентиляция П1 — 北");
    f["objects"][2]["fields"]["m_arrRefs"]
        .as_array_mut()
        .unwrap()
        .pop();
    f["objects"][0]["fields"]["m_rgSections"] = json!([pointer(30, 5)]);
    f["objects"].as_array_mut().unwrap().push(object(
        4,
        "RbsDuctSection",
        json!({"m_rgSection":[{"m_id":eid(103),"m_connType":1}],"m_rgNetworkSegmentIds":[]}),
    ));
    f["edges"]
        .as_array_mut()
        .unwrap()
        .push(edge(0, 30, 5, 4, 4));
    let s = project(f).unwrap();
    assert_eq!(s.name.as_deref(), Some("Приточная вентиляция П1 — 北"));
    assert_eq!(s.members.into_iter().collect::<Vec<_>>(), vec![101, 103]);
}

#[test]
fn missing_and_ambiguous_edges_fail_instead_of_searching_for_a_connector() {
    let mut f = fixture();
    f["edges"].as_array_mut().unwrap().pop();
    assert!(project(f).is_err());
    let mut f = fixture();
    let duplicate = f["edges"][1].clone();
    f["edges"].as_array_mut().unwrap().push(duplicate);
    assert!(project(f).is_err());
}

#[test]
fn mismatching_tokens_classes_and_identity_are_rejected() {
    for path in ["token", "class", "identity"] {
        let mut f = fixture();
        match path {
            "token" => f["edges"][1]["pointer_token"] = json!(99),
            "class" => f["objects"][2]["class_tag"] = json!(99),
            _ => f["objects"][0]["fields"]["m_id"] = eid(7),
        }
        assert!(project(f).is_err());
    }
}

#[test]
fn unsupported_reference_and_large_ids_are_not_truncated_or_dropped() {
    let mut f = fixture();
    f["objects"][2]["fields"]["m_arrRefs"][0]["m_connType"] = json!(99);
    assert!(project(f).is_err());
    let mut f = fixture();
    f["objects"][2]["fields"]["m_arrRefs"][0]["m_id"] = eid(1u64 << 40);
    assert!(project(f).is_err());
}

#[test]
fn empty_name_is_distinct_from_missing_and_unnamed_is_explicit() {
    let mut f = fixture();
    f["objects"][0]["fields"]["m_number"] = json!("");
    let s = project(f).unwrap();
    assert_eq!(s.saved_name, "");
    assert_eq!(s.name.as_deref(), Some("<unnamed>"));
    let mut f = fixture();
    f["objects"][0]["fields"]
        .as_object_mut()
        .unwrap()
        .remove("m_number");
    assert!(project(f).is_err());
}
