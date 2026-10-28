//! Independent decoding of the logical graph observed in public 431 samples.
//! IDs are scoped to their stream. Null attribute slots refer to a separate
//! partition-properties stream; they must never be resolved in the node graph.
use crate::{Container, Cursor, Result};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const MAX_OBJECTS: usize = 1_000_000;
const MAX_DEPTH: usize = 256;

#[derive(Debug, Clone, Serialize)]
pub struct Object {
    pub page_index: Option<usize>,
    pub serialized_id: u32,
    pub serialized_class: u32,
    pub record_offset: usize,
    pub record_bytes: usize,
    pub name: Option<String>,
    pub type_reference: Option<u32>,
    pub flags: u32,
    pub guid_index: Option<u32>,
    pub attributes: Vec<Option<u32>>,
    pub children: Vec<u32>,
    pub values: Value,
}

struct Graph<'a> {
    c: Cursor<'a>,
    objects: BTreeMap<u32, Object>,
    order: Vec<u32>,
    active: BTreeSet<u32>,
    depth: usize,
}
impl<'a> Graph<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self {
            c: Cursor::new(b),
            objects: BTreeMap::new(),
            order: Vec::new(),
            active: BTreeSet::new(),
            depth: 0,
        }
    }
    fn count(&mut self) -> Result<usize> {
        let n = self.c.u32()? as usize;
        if n > MAX_OBJECTS {
            return Err("Metadata count exceeds budget".into());
        }
        Ok(n)
    }
    fn string(&mut self) -> Result<Option<String>> {
        let n = self.c.u32()?;
        if n == u32::MAX {
            return Ok(None);
        }
        if n > 1_048_576 {
            return Err(format!(
                "Metadata string exceeds budget at {}: {n}",
                self.c.pos - 4
            ));
        }
        let value = std::str::from_utf8(self.c.take(n as usize)?)
            .map_err(|_| "Invalid metadata UTF-8")?
            .to_owned();
        self.c.align(4)?;
        Ok(Some(value))
    }
    fn doubles(&mut self, n: usize) -> Result<Vec<f64>> {
        self.c.align(8)?;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let v = f64::from_le_bytes(self.c.take(8)?.try_into().unwrap());
            if !v.is_finite() {
                return Err("Nonfinite metadata number".into());
            }
            out.push(v);
        }
        Ok(out)
    }
    fn pointers(&mut self) -> Result<Vec<Option<u32>>> {
        let n = self.count()?;
        let start = self.c.pos - 4;
        let mut refs = Vec::new();
        for i in 0..n {
            refs.push(self.pointer().map_err(|e| {
                format!(
                    "Array at {start}, item {i}/{n}, last references {:?}: {e}",
                    &refs[refs.len().saturating_sub(8)..]
                )
            })?);
        }
        Ok(refs)
    }
    fn value(&mut self) -> Result<Value> {
        let tag = self.c.u32()?;
        let value = match tag {
            3 => json!(self.doubles(1)?[0]),
            7 | 8 | 9 => json!(self.doubles(3)?),
            10 => json!(self.string()?),
            _ => return Err(format!("Unsupported saved material value tag {tag}")),
        };
        Ok(json!({"tag": tag, "value": value}))
    }
    fn variant(&mut self) -> Result<Value> {
        let tag = self.c.u32()?;
        let value = match tag {
            0 => Value::Null,
            1 | 6 | 7 | 10 | 11 => json!(self.doubles(1)?[0]),
            2 => json!(self.c.u32()? as i32),
            3 => {
                let v = self.c.u32()?;
                if v > 1 {
                    return Err("Invalid property boolean".into());
                }
                json!(v == 1)
            }
            4 | 9 => json!(self.string()?),
            8 => {
                let id = self.pointer()?.ok_or("Named constant is null")?;
                let object = self.objects.get(&id).ok_or("Named constant missing")?;
                if object.serialized_class != 52 {
                    return Err("Named constant has unexpected type".into());
                }
                json!({"name_reference":id,"display":object.values["display"],"internal":object.values["internal"]})
            }
            12 => json!(self.doubles(3)?),
            13 => json!(self.doubles(2)?),
            14 => json!(self.c.u32()?),
            15 => {
                self.c.align(8)?;
                json!({"int64_decimal":(self.c.u64()? as i64).to_string()})
            }
            16 => {
                self.c.align(8)?;
                json!({"uint64_decimal":self.c.u64()?.to_string()})
            }
            _ => {
                return Err(format!(
                    "Unsupported property value tag {tag} at {}",
                    self.c.pos - 4
                ));
            }
        };
        Ok(json!({"tag":tag, "value":value}))
    }
    fn pointer(&mut self) -> Result<Option<u32>> {
        let start = self.c.pos;
        let id = self.c.u32()?;
        if id == 0 {
            return Ok(None);
        }
        if id == 1 {
            let target = self.c.u32()?;
            if self.active.contains(&target) || !self.objects.contains_key(&target) {
                return Err(format!(
                    "Unresolved/cyclic metadata reference {target} at {start}"
                ));
            }
            return Ok(Some(target));
        }
        if id < 100 || self.objects.contains_key(&id) || self.active.contains(&id) {
            return Err(format!(
                "Invalid/duplicate metadata identity {id} at {start}; active records {:?}",
                self.active
                    .iter()
                    .map(|id| (
                        *id,
                        self.objects
                            .get(id)
                            .map(|o| (o.serialized_class, o.record_offset))
                    ))
                    .collect::<Vec<_>>()
            ));
        }
        if self.objects.len() + self.active.len() >= MAX_OBJECTS || self.depth >= MAX_DEPTH {
            return Err("Metadata object/depth budget exceeded".into());
        }
        let class = self.c.u32()?;
        self.active.insert(id);
        self.depth += 1;
        self.order.push(id);
        let mut o = Object {
            page_index: None,
            serialized_id: id,
            serialized_class: class,
            record_offset: start,
            record_bytes: 0,
            name: None,
            type_reference: None,
            flags: 0,
            guid_index: None,
            attributes: vec![],
            children: vec![],
            values: Value::Null,
        };
        self.objects.insert(id, o.clone());
        match class {
            52 => o.values = json!({"display": self.string()?, "internal": self.string()?}),
            185 => {
                let text = self.string()?;
                let label = self.string()?;
                let resources = crate::saved_asset_records(&mut self.c)?;
                o.values = crate::saved_json_record(text, label, resources);
            }
            22 | 53 | 31 | 39 | 40 | 41 | 66 | 70 | 79 | 86 | 92 | 97 | 98 | 200 => {
                o.name = self.string()?;
                o.type_reference = self.pointer()?;
                o.flags = self.c.u32()?;
                match class {
                    22 | 53 => {
                        o.guid_index = Some(self.c.u32()?);
                        o.attributes = self.pointers()?;
                        if class == 53 {
                            o.children = self
                                .pointers()?
                                .into_iter()
                                .map(|p| p.ok_or_else(|| "Null logical child".to_string()))
                                .collect::<Result<_>>()?;
                        }
                    }
                    31 => o.values = json!({"material_components": self.doubles(14)?}),
                    39 => {
                        if o.flags != 0x20000 {
                            return Err("Unsupported logical affine-transform flags".into());
                        }
                        o.values = json!({"affine_components_source":self.doubles(12)?,"raw_transform_suffix":self.c.u32()?,"layout_requires_review":true});
                    }
                    40 => {
                        if o.flags != 0x20000 {
                            return Err(format!(
                                "Unsupported logical transform flags {:#x}",
                                o.flags
                            ));
                        }
                        o.values = json!({"translation_source_units": self.doubles(3)?});
                    }
                    41 => {
                        if o.flags != 0x20000 {
                            return Err("Unsupported logical rigid-transform flags".into());
                        }
                        o.values = json!({"transform_components_source":self.doubles(7)?,"quaternion_order_verified":false});
                    }
                    66 => {
                        self.c.align(8)?;
                        let handle = self.c.u64()?;
                        // Text avoids loss of integer precision in JavaScript.
                        o.values = json!({"uint64_hex": format!("{handle:X}"), "uint64_decimal": handle.to_string()});
                    }
                    70 => o.values = json!({"string_value":o.name}),
                    92 => {
                        let options = self.c.u32()?;
                        let strings = (0..4).map(|_| self.string()).collect::<Result<Vec<_>>>()?;
                        self.c.align(8)?;
                        let published = self.c.u64()?.to_string();
                        let more = (0..4).map(|_| self.string()).collect::<Result<Vec<_>>>()?;
                        self.c.align(8)?;
                        let expires = self.c.u64()?.to_string();
                        o.values = json!({"publish_flags":options,"saved_strings":strings,"publish_time_raw":published,"additional_strings":more,"expiry_time_raw":expires});
                    }
                    79 => {
                        let mut links = Vec::new();
                        for _ in 0..self.count()? {
                            links.push(json!({"title":self.string()?,"url":self.string()?,"category_reference":self.pointer()?,"raw_flags":self.c.u32()?,"fetched":false}));
                        }
                        o.values = json!({"hyperlinks":links});
                    }
                    200 => {
                        let asset = self.pointer()?;
                        if asset.is_some_and(|id| self.objects[&id].serialized_class != 185) {
                            return Err("Unsupported saved asset reference".into());
                        }
                        o.values = json!({"asset_reference":asset});
                    }
                    86 => {
                        let mut properties = Vec::new();
                        for _ in 0..self.count()? {
                            let name = self.pointer()?.ok_or("Property name missing")?;
                            if self.objects[&name].serialized_class != 52 {
                                return Err("Property name has unexpected type".into());
                            }
                            properties.push(json!({"name_reference":name,"value":self.variant()?}));
                        }
                        o.values = json!({"properties":properties});
                    }
                    97 | 98 => {
                        let mut channels = Vec::new();
                        for _ in 0..if class == 97 { 5 } else { 1 } {
                            let mut shaders = Vec::new();
                            for _ in 0..self.count()? {
                                let name = self.string()?;
                                let mut parameters = Vec::new();
                                for _ in 0..self.count()? {
                                    parameters.push(
                                        json!({"name": self.string()?, "value": self.value()?}),
                                    );
                                }
                                shaders.push(json!({"name": name, "parameters": parameters}));
                            }
                            channels.push(shaders);
                        }
                        o.values = json!({"saved_shader_channels": channels});
                    }
                    _ => unreachable!(),
                }
            }
            _ => return Err(format!("Unsupported metadata class {class} at {start}")),
        }
        o.record_bytes = self.c.pos - start;
        self.depth -= 1;
        self.active.remove(&id);
        self.objects.insert(id, o);
        Ok(Some(id))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AttributeReference {
    pub stream: String,
    pub page_index: Option<usize>,
    pub serialized_id: u32,
}
#[derive(Debug, Serialize)]
pub struct Node {
    pub index: usize,
    pub serialized_id: u32,
    pub parent_index: Option<usize>,
    pub name: Option<String>,
    pub class_name: Option<String>,
    pub class_display: Option<String>,
    pub guid_index: Option<u32>,
    pub native_guid: Option<String>,
    pub guid_status: String,
    pub attributes: Vec<AttributeReference>,
    pub unresolved_attribute_slots: usize,
    pub record_offset: usize,
    pub record_bytes: usize,
}
#[derive(Debug, Serialize)]
pub struct LogicalModel {
    pub namespace: String,
    pub stream: String,
    pub status: &'static str,
    pub diagnostic: Option<String>,
    pub declared_property_slots: usize,
    pub decoded_property_slots: usize,
    pub property_page_slots: Vec<usize>,
    pub property_diagnostics: Vec<String>,
    pub partition: Value,
    pub nodes: Vec<Node>,
    pub objects: Vec<Object>,
    pub property_objects: Vec<Object>,
}

pub fn read_logical_models(container: &Container) -> Vec<LogicalModel> {
    read_logical_models_with_progress(container, &mut |_| {})
}
pub fn read_logical_models_with_progress(
    container: &Container,
    phase: &mut dyn FnMut(&str),
) -> Vec<LogicalModel> {
    container
        .blocks
        .iter()
        .filter_map(|block| {
            let namespace = block.entry.name.strip_suffix("\\LcOpNwdLogicalHierarchy")?;
            phase("Чтение исходного дерева NWD");
            let mut result = LogicalModel {
                namespace: namespace.into(),
                stream: block.entry.name.clone(),
                status: "unread",
                diagnostic: None,
                declared_property_slots: 0,
                decoded_property_slots: 0,
                property_page_slots: vec![],
                property_diagnostics: vec![],
                partition: Value::Null,
                nodes: vec![],
                objects: vec![],
                property_objects: vec![],
            };
            let decoded: Result<()> = (|| {
                if let Some(e) = &block.diagnostic {
                    return Err(e.clone());
                }
                let mut graph = Graph::new(&block.body);
                let pages = graph.count()?;
                if pages > 100_000 {
                    return Err("Property-page budget exceeded".into());
                }
                for _ in 0..pages {
                    let n = graph.count()?;
                    result.declared_property_slots = result
                        .declared_property_slots
                        .checked_add(n)
                        .ok_or("Property slot overflow")?;
                    if result.declared_property_slots > MAX_OBJECTS {
                        return Err("Property-slot budget exceeded".into());
                    }
                    result.property_page_slots.push(n);
                }
                // The partition root is already serialized in LcOpNwdPartition.
                // Its external identity is followed by CHILD COUNT, not class ID.
                let root_at = graph.c.pos;
                let root = graph.c.u32()?;
                if root < 100 {
                    return Err("Invalid external root identity".into());
                }
                let child_count = graph.count()?;
                graph.active.insert(root);
                graph.order.push(root);
                let mut roots = Vec::new();
                for _ in 0..child_count {
                    let id = graph.pointer()?.ok_or("Null top-level logical node")?;
                    if !matches!(graph.objects[&id].serialized_class, 22 | 53) {
                        return Err("Non-node in root children".into());
                    }
                    roots.push(id);
                }
                graph.active.remove(&root);
                graph.objects.insert(
                    root,
                    Object {
                        page_index: None,
                        serialized_id: root,
                        serialized_class: 32,
                        record_offset: root_at,
                        record_bytes: 8,
                        name: None,
                        type_reference: None,
                        flags: 0,
                        guid_index: None,
                        attributes: vec![],
                        children: roots,
                        values: json!({"external_partition_root":true}),
                    },
                );
                let trailer = graph.c.u32()?;
                if trailer != 1 {
                    return Err(format!(
                        "Unsupported logical trailer marker {trailer} at {}; root children {:?}",
                        graph.c.pos - 4,
                        graph.objects[&root].children
                    ));
                }
                graph.c.align(8)?;
                if graph.c.pos != block.body.len() {
                    return Err("Unparsed logical suffix".into());
                }
                let prop_stream = format!("{namespace}\\LcOaPartitionProps");
                let mut prop_ids = vec![None; result.declared_property_slots];
                if let Some(b) = container
                    .blocks
                    .iter()
                    .find(|b| b.entry.name == prop_stream && b.diagnostic.is_none())
                {
                    if b.segments.len() != pages {
                        result
                            .property_diagnostics
                            .push("Property page/segment directory mismatch".into());
                    } else {
                        let mut slot = 0;
                        for (page, (&count, segment)) in result
                            .property_page_slots
                            .iter()
                            .zip(&b.segments)
                            .enumerate()
                        {
                            let bytes = crate::checked_slice(
                                &b.body,
                                segment.output_offset,
                                segment.expanded_bytes,
                            )?;
                            let mut g = Graph::new(bytes);
                            let read: Result<()> = (|| {
                                for i in 0..count {
                                    if result.decoded_property_slots%4096==0 {phase(&format!("Свойства NWD: прочитано {} из {} записей",result.decoded_property_slots,result.declared_property_slots));}
                                    let id = g.pointer()?.ok_or("Null property page record")?;
                                    prop_ids[slot + i] = Some((page, id));
                                    result.decoded_property_slots += 1;
                                }
                                if g.c.bytes[g.c.pos..].len() > 7
                                    || g.c.bytes[g.c.pos..].iter().any(|b| *b != 0)
                                {
                                    return Err("Unparsed partition-property suffix".into());
                                }
                                Ok(())
                            })();
                            if let Err(e) = read {
                                result
                                    .property_diagnostics
                                    .push(format!("Property page {page}: {e}"));
                            }
                            for (_, mut o) in g.objects {
                                o.page_index = Some(page);
                                o.record_offset += segment.output_offset;
                                result.property_objects.push(o);
                            }
                            slot += count;
                        }
                    }
                } else if result.declared_property_slots > 0 {
                    result
                        .property_diagnostics
                        .push("Partition property stream is unavailable".into());
                }
                let mut next = 0;
                let mut refs: BTreeMap<u32, Vec<AttributeReference>> = BTreeMap::new();
                for id in &graph.order {
                    let o = &graph.objects[id];
                    if !matches!(o.serialized_class, 22 | 53) {
                        continue;
                    }
                    let attributes = refs.entry(*id).or_default();
                    for attr in &o.attributes {
                        if let Some(id) = attr {
                            attributes.push(AttributeReference {
                                stream: block.entry.name.clone(),
                                page_index: None,
                                serialized_id: *id,
                            });
                        } else {
                            if let Some(Some((page, id))) = prop_ids.get(next) {
                                attributes.push(AttributeReference {
                                    stream: prop_stream.clone(),
                                    page_index: Some(*page),
                                    serialized_id: *id,
                                });
                            }
                            next += 1;
                        }
                    }
                }
                if next != result.declared_property_slots {
                    // The occurrence order is still known, but implicit external
                    // property-slot attribution is no longer trustworthy.
                    for attributes in refs.values_mut() {attributes.retain(|a| a.page_index.is_none());}
                    result.property_diagnostics.push("Logical slots and property count disagree; external property attribution disabled".into());
                }
                fn walk(
                    id: u32,
                    parent: Option<usize>,
                    graph: &Graph,
                    refs: &BTreeMap<u32, Vec<AttributeReference>>,
                    out: &mut Vec<Node>,
                    active: &mut BTreeSet<u32>,
                ) -> Result<()> {
                    if out.len() >= MAX_OBJECTS || active.len() >= MAX_DEPTH || !active.insert(id) {
                        return Err("Logical occurrence/depth/cycle budget".into());
                    }
                    let o = graph.objects.get(&id).ok_or("Unknown logical child")?;
                    if !matches!(o.serialized_class, 32 | 22 | 53) {
                        return Err("Logical child is not a node".into());
                    }
                    let index = out.len();
                    let label = o.type_reference.and_then(|r| graph.objects.get(&r));
                    if label.is_some_and(|v| v.serialized_class != 52) {
                        return Err("Logical name has unexpected type".into());
                    }
                    out.push(Node {
                        index,
                        serialized_id: id,
                        parent_index: parent,
                        name: o.name.clone(),
                        class_name: label
                            .and_then(|x| x.values["internal"].as_str())
                            .map(String::from),
                        class_display: label
                            .and_then(|x| x.values["display"].as_str())
                            .map(String::from),
                        guid_index: o.guid_index,
                        native_guid: None,
                        guid_status: "not_read".into(),
                        attributes: refs.get(&id).cloned().unwrap_or_default(),
                        unresolved_attribute_slots: o
                            .attributes
                            .len()
                            .saturating_sub(refs.get(&id).map_or(0, Vec::len)),
                        record_offset: o.record_offset,
                        record_bytes: o.record_bytes,
                    });
                    for child in &o.children {
                        walk(*child, Some(index), graph, refs, out, active)?;
                    }
                    active.remove(&id);
                    Ok(())
                }
                phase("Сборка исходного дерева NWD");
                walk(
                    root,
                    None,
                    &graph,
                    &refs,
                    &mut result.nodes,
                    &mut BTreeSet::new(),
                )?;
                let store = container.blocks.iter().find(|b| {
                    b.entry.name == format!("{namespace}\\LcOpGuidStore") && b.diagnostic.is_none()
                });
                for node in &mut result.nodes {
                    let Some(index) = node.guid_index else {
                        continue;
                    };
                    if index == 0 {
                        node.guid_status = "no_index".into();
                        continue;
                    }
                    let Some(store) = store else {
                        node.guid_status = "missing_store".into();
                        continue;
                    };
                    let mut c = Cursor::new(&store.body);
                    let decoded: Result<Option<String>> = (|| {
                        if c.u32()? != 1 {
                            return Err("Unsupported GUID store version".into());
                        }
                        let count = c.u32()? as usize;
                        if count > MAX_OBJECTS || store.body.len() != 8 + count * 16 {
                            return Err("GUID store length mismatch".into());
                        }
                        if index as usize > count {
                            return Ok(None);
                        }
                        let bytes =
                            crate::checked_slice(&store.body, 8 + (index as usize - 1) * 16, 16)?;
                        Ok(Some(format!(
                            "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{}",
                            u32::from_le_bytes(bytes[..4].try_into().unwrap()),
                            u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
                            u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
                            bytes[8],
                            bytes[9],
                            bytes[10..]
                                .iter()
                                .map(|b| format!("{b:02x}"))
                                .collect::<String>()
                        )))
                    })();
                    match decoded {
                        Ok(Some(guid)) => {
                            node.native_guid = Some(guid);
                            node.guid_status = "resolved".into();
                        }
                        Ok(None) => node.guid_status = "index_out_of_range".into(),
                        Err(_) => node.guid_status = "unsupported_store".into(),
                    }
                }
                // Node records are already represented in `nodes` with byte
                // addresses; retain the inline attribute/name graph only once.
                result.objects = graph
                    .objects
                    .into_values()
                    .filter(|o| !matches!(o.serialized_class, 22 | 32 | 53))
                    .collect();
                for object in result.objects.iter().chain(result.property_objects.iter()) {
                    if object.serialized_class==185 {if let Some(error)=object.values["diagnostic"].as_str(){result.property_diagnostics.push(format!("Saved appearance JSON {} at {}: {error}",object.serialized_id,object.record_offset));}}
                }
                if result.decoded_property_slots != result.declared_property_slots
                    || !result.property_diagnostics.is_empty()
                {
                    return Err("Logical tree decoded; some property pages are unavailable".into());
                }
                Ok(())
            })();
            match decoded {
                Ok(()) => result.status = "decoded_logical_subset",
                Err(e) => {
                    result.status = "unsupported_or_partial";
                    result.diagnostic = Some(e);
                }
            }
            result.partition = partition_prefix(container, namespace);
            if let Some(node) = result.nodes.first_mut() {
                node.name = result.partition["name"].as_str().map(String::from);
                node.class_name = result.partition["class_name"].as_str().map(String::from);
                node.class_display = result.partition["class_display"].as_str().map(String::from);
            }
            Some(result)
        })
        .collect()
}

fn partition_prefix(container: &Container, namespace: &str) -> Value {
    let Some(block) = container
        .blocks
        .iter()
        .find(|b| b.entry.name == format!("{namespace}\\LcOpNwdPartition"))
    else {
        return json!({"status":"missing"});
    };
    let mut g = Graph::new(&block.body);
    let read: Result<Value> = (|| {
        let id = g.c.u32()?;
        if id < 100 || g.c.u32()? != 32 {
            return Err("Unsupported partition header".into());
        }
        let source_flags = g.c.u32()?;
        let name = g.string()?;
        let label = g.pointer()?.ok_or("Partition name absent")?;
        let label = g.objects[&label].values.clone();
        let flags = g.c.u32()?;
        let guid_index = g.c.u32()?;
        let attributes = g.pointers()?;
        let tail = crate::fragments::partition_tail(
            &block.body,
            g.c.pos,
            g.objects
                .iter()
                .map(|(id, o)| (*id, o.serialized_class, o.values.clone()))
                .collect(),
        );
        let tail = match tail {
            Ok(v) => v,
            Err(e) => json!({"status":"unread","diagnostic":e}),
        };
        Ok(
            json!({"status":"header_decoded","name":name,"class_name":label["internal"],"class_display":label["display"],"serialized_id":id,"source_flags":source_flags,"flags":flags,"guid_index":guid_index,"attributes":attributes,"objects":g.objects.values().collect::<Vec<_>>(),"tail_offset":g.c.pos,"tail":tail}),
        )
    })();
    match read {
        Ok(v) => v,
        Err(e) => json!({"status":"unsupported_or_partial","diagnostic":e,"offset":g.c.pos}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{align, envelope, u32v, zip};
    fn words(b: &mut Vec<u8>, v: &[u32]) {
        for x in v {
            u32v(b, *x);
        }
    }
    fn text(b: &mut Vec<u8>, v: Option<&str>) {
        match v {
            Some(v) => {
                u32v(b, v.len() as u32);
                b.extend(v.as_bytes());
                align(b, 4);
            }
            None => u32v(b, u32::MAX),
        }
    }
    fn leaf(b: &mut Vec<u8>, id: u32, name: &str, attrs: u32) {
        words(b, &[id, 22]);
        text(b, Some(name));
        words(b, &[0, 0, 0, attrs]);
    }
    fn finish(b: &mut Vec<u8>) {
        u32v(b, 1);
        align(b, 8);
    }
    fn parse(b: Vec<u8>, pages: Vec<Vec<u8>>) -> LogicalModel {
        let mut entries = vec![(
            "synthetic\\LcOpNwdLogicalHierarchy".into(),
            1,
            zip(&b),
            0,
            0,
        )];
        if !pages.is_empty() {
            entries.push((
                "synthetic\\LcOaPartitionProps".into(),
                1,
                pages.iter().flat_map(|b| zip(b)).collect(),
                0,
                0,
            ));
        }
        read_logical_models(&crate::read_container(&envelope(entries)).unwrap()).remove(0)
    }
    fn page(v: &str) -> Vec<u8> {
        let mut b = vec![];
        words(&mut b, &[100, 70]);
        text(&mut b, Some(v));
        words(&mut b, &[0, 0]);
        b
    }
    #[test]
    fn root_child_count_is_not_a_serialized_class_and_pages_keep_separate_id_spaces() {
        let mut b = vec![];
        words(&mut b, &[2, 1, 1, 100, 2]);
        leaf(&mut b, 101, "Synthetic A", 1);
        u32v(&mut b, 0);
        leaf(&mut b, 102, "Синтетический Б", 1);
        u32v(&mut b, 0);
        finish(&mut b);
        let m = parse(b, vec![page("page A"), page("page B")]);
        assert_eq!(m.status, "decoded_logical_subset");
        assert_eq!(m.nodes.len(), 3);
        assert_eq!(m.nodes[2].parent_index, Some(0));
        assert_eq!(m.nodes[2].name.as_deref(), Some("Синтетический Б"));
        assert_eq!(m.nodes[1].attributes[0].page_index, Some(0));
        assert_eq!(m.nodes[2].attributes[0].page_index, Some(1));
        assert_eq!(m.nodes[1].attributes[0].serialized_id, 100);
        assert_eq!(m.nodes[2].attributes[0].serialized_id, 100);
        assert_eq!(m.property_objects[0].values["string_value"], "page A");
        assert_eq!(m.property_objects[1].values["string_value"], "page B");
    }
    #[test]
    fn missing_property_page_does_not_erase_a_valid_tree() {
        let mut b = vec![];
        words(&mut b, &[1, 1, 100, 1]);
        leaf(&mut b, 101, "A", 1);
        u32v(&mut b, 0);
        finish(&mut b);
        let m = parse(b, vec![]);
        assert_eq!(m.nodes.len(), 2);
        assert_eq!(m.nodes[1].unresolved_attribute_slots, 1);
        assert_eq!(m.status, "unsupported_or_partial");
        assert_eq!(m.decoded_property_slots, 0);
    }
    #[test]
    fn wrong_slot_count_and_wrong_root_count_are_not_complete() {
        for counts in [[1, 0, 100, 1], [1, 1, 100, 2]] {
            let mut b = vec![];
            words(&mut b, &counts);
            leaf(&mut b, 101, "A", 1);
            u32v(&mut b, 0);
            finish(&mut b);
            assert_ne!(parse(b, vec![page("x")]).status, "decoded_logical_subset");
        }
    }
    #[test]
    fn saved_json_asset_preserves_empty_resource_suffix_without_invented_tail() {
        let mut b = vec![];
        words(&mut b, &[0, 100, 1]);
        leaf(&mut b, 101, "A", 1);
        words(&mut b, &[102, 200]);
        text(&mut b, None);
        words(&mut b, &[0, 0, 103, 185]);
        text(&mut b, Some("{\"version\":2}"));
        text(&mut b, None);
        u32v(&mut b, 2);
        for t in ["", "", "", "synthetic:texture", "", "original"] {
            text(&mut b, Some(t));
        }
        finish(&mut b);
        let m = parse(b, vec![]);
        assert_eq!(m.status, "decoded_logical_subset");
        let asset = m
            .objects
            .iter()
            .find(|o| o.serialized_class == 185)
            .unwrap();
        assert_eq!(
            asset.values["saved_resources"][1]["saved_suffix"],
            "original"
        );
        assert_eq!(asset.values["references_resolved"], false);
    }
    #[test]
    fn malformed_saved_json_keeps_bounded_resources_and_the_source_tree() {
        let mut b = vec![];
        words(&mut b, &[0, 100, 1]);
        leaf(&mut b, 101, "A", 1);
        words(&mut b, &[102, 200]);
        text(&mut b, None);
        words(&mut b, &[0, 0, 103, 185]);
        text(&mut b, Some("{invalid"));
        text(&mut b, None);
        u32v(&mut b, 0);
        finish(&mut b);
        let m = parse(b, vec![]);
        assert_eq!(m.nodes.len(), 2);
        assert_eq!(m.status, "unsupported_or_partial");
        let asset = m
            .objects
            .iter()
            .find(|o| o.serialized_class == 185)
            .unwrap();
        assert_eq!(asset.values["raw_json"], "{invalid");
        assert_eq!(asset.values["saved_json_status"], "unread");
        assert!(!m.property_diagnostics.is_empty());
    }
    #[test]
    fn legacy_material_has_five_shader_channels() {
        let mut b = vec![];
        words(&mut b, &[0, 100, 1]);
        leaf(&mut b, 101, "A", 1);
        words(&mut b, &[102, 97]);
        text(&mut b, None);
        words(&mut b, &[0, 0, 0, 0, 0, 0, 0]);
        finish(&mut b);
        let m = parse(b, vec![]);
        assert_eq!(m.status, "decoded_logical_subset");
        assert_eq!(
            m.objects
                .iter()
                .find(|o| o.serialized_class == 97)
                .unwrap()
                .values["saved_shader_channels"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
    }
    #[test]
    fn precise_integer_boolean_and_named_constant_values() {
        for (tag, raw, want) in [
            (2, (-17i32).to_le_bytes().to_vec(), json!(-17)),
            (3, 1u32.to_le_bytes().to_vec(), json!(true)),
            (
                16,
                u64::MAX.to_le_bytes().to_vec(),
                json!({"uint64_decimal":u64::MAX.to_string()}),
            ),
        ] {
            let mut b = vec![];
            u32v(&mut b, tag);
            if tag == 16 {
                align(&mut b, 8);
            }
            b.extend(raw);
            let mut g = Graph::new(&b);
            assert_eq!(g.variant().unwrap()["value"], want);
        }
        let bad = [3u32.to_le_bytes(), 2u32.to_le_bytes()].concat();
        assert!(Graph::new(&bad).variant().is_err());
        let mut named = vec![];
        words(&mut named, &[8, 100, 52]);
        text(&mut named, Some("Displayed"));
        text(&mut named, Some("internal"));
        let value = Graph::new(&named).variant().unwrap();
        assert_eq!(value["value"]["display"], "Displayed");
        assert_eq!(value["value"]["internal"], "internal");
    }
    #[test]
    fn truncated_metadata_and_cycles_never_become_complete() {
        let mut b = vec![];
        words(&mut b, &[0, 100, 1]);
        leaf(&mut b, 101, "A", 0);
        finish(&mut b);
        for n in 0..b.len() {
            assert_ne!(
                parse(b[..n].to_vec(), vec![]).status,
                "decoded_logical_subset",
                "prefix {n}"
            );
        }
        let mut b = vec![];
        words(&mut b, &[0, 100, 1, 101, 53]);
        text(&mut b, Some("cycle"));
        words(&mut b, &[0, 0, 0, 0, 1, 1, 101]);
        finish(&mut b);
        assert!(parse(b, vec![]).diagnostic.unwrap().contains("cyclic"));
    }
}
