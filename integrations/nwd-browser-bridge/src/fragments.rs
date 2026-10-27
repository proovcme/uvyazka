//! Serialized fragment graph subset with typed references and raw provenance.
use crate::geometry::MeshDefinition;
use crate::{Block, Container, Cursor, Result};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
/// Column-major affine matrix. The explicit transform replaces the bounds
/// origin; adding that origin again displaces rotated instances a second time.
fn rigid_matrix(t: [f64; 3], q: [f64; 4]) -> Result<[f64; 16]> {
    let [x, y, z, w] = q;
    if t.iter().chain(q.iter()).any(|v| !v.is_finite())
        || (q.iter().map(|v| v * v).sum::<f64>() - 1.).abs() > 1e-5
    {
        return Err("Unsupported non-unit/nonfinite placement quaternion".into());
    }
    Ok([
        1. - 2. * (y * y + z * z),
        2. * (x * y + z * w),
        2. * (x * z - y * w),
        0.,
        2. * (x * y - z * w),
        1. - 2. * (x * x + z * z),
        2. * (y * z + x * w),
        0.,
        2. * (x * z + y * w),
        2. * (y * z - x * w),
        1. - 2. * (x * x + y * y),
        0.,
        t[0],
        t[1],
        t[2],
        1.,
    ])
}
#[derive(Debug, Clone)]
enum Object {
    Pending,
    Fragment,
    Translation([f64; 3]),
    Rigid([f64; 3], [f64; 4]),
    Material([f32; 14]),
    Appearance(u32, u32, Option<u32>),
    Bounds([f32; 6], [f64; 3], f32),
    Asset(Value),
    Schema(Value),
    Light(Value),
}
#[derive(Debug, Serialize, Clone)]
pub struct AssetRecord {
    pub serialized_id: u32,
    pub serialized_class: u32,
    pub record_offset: usize,
    pub record_bytes: usize,
    pub value: Value,
}
struct Graph<'a> {
    cursor: Cursor<'a>,
    objects: BTreeMap<u32, (u32, Object)>,
    depth: usize,
    asset_values: usize,
    assets: Vec<AssetRecord>,
}
impl Graph<'_> {
    fn count(&mut self) -> Result<usize> {
        let n = self.cursor.u32()? as usize;
        self.asset_values = self
            .asset_values
            .checked_add(n)
            .ok_or("Asset count overflow")?;
        if self.asset_values > 1_000_000 {
            return Err("Material asset budget exceeded".into());
        }
        Ok(n)
    }
    fn string(&mut self) -> Result<Option<String>> {
        let n = self.cursor.u32()?;
        if n == u32::MAX {
            return Ok(None);
        }
        if n > 1_048_576 {
            return Err("Asset string budget exceeded".into());
        }
        let value = std::str::from_utf8(self.cursor.take(n as usize)?)
            .map_err(|_| "Invalid asset UTF-8")?
            .to_owned();
        self.cursor.align(4)?;
        Ok(Some(value))
    }
    fn double_values(&mut self, n: usize) -> Result<Vec<f64>> {
        self.cursor.align(8)?;
        (0..n).map(|_| self.f64()).collect()
    }
    fn string_values(&mut self) -> Result<Vec<Option<String>>> {
        let n = self.count()?;
        (0..n).map(|_| self.string()).collect()
    }
    fn asset(&mut self) -> Result<Value> {
        let key = self.string()?;
        let schema = self.string()?;
        let count = self.count()?;
        let mut properties = Vec::new();
        for _ in 0..count {
            let offset = self.cursor.pos;
            let kind = self.cursor.u32()?;
            let flags = self.cursor.u32()?;
            let name = self.string()?;
            let constraint = self.count()?;
            let values_count = self.count()?;
            let links_count = self.count()?;
            let links = (0..links_count)
                .map(|_| self.pointer(182))
                .collect::<Result<Vec<_>>>()?;
            let mut values = Vec::new();
            for _ in 0..values_count {
                values.push(match kind {
                    2 => {
                        let v = self.cursor.u32()?;
                        if v > 1 {
                            return Err("Invalid asset boolean".into());
                        }
                        json!(v == 1)
                    }
                    4 => json!(self.double_values(4)?),
                    6 | 15 => json!(self.cursor.u32()? as i32),
                    8 => json!(self.double_values(1)?[0]),
                    9 => json!(self.double_values(3)?),
                    10 | 12 | 16 => json!(self.string()?),
                    11 => json!({"connection_only":true}),
                    _ => {
                        return Err(format!(
                            "Unsupported material property tag {kind} at {offset}"
                        ));
                    }
                });
            }
            let mut choices = Vec::new();
            if kind == 15 {
                for _ in 0..constraint {
                    choices.push(json!({"value":self.cursor.u32()? as i32,"label":self.string()?}));
                }
            } else if constraint != 1 && !(kind == 9 && constraint == 3) {
                return Err("Unsupported material constraint layout".into());
            }
            properties.push(json!({"record_offset":offset,"tag":kind,"raw_flags":flags,"name":name,"values":values,"connections":links,"choices":choices}));
        }
        let schema_reference = self.pointer(183)?;
        let guid = self
            .cursor
            .take(16)?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let saved_strings = [
            self.string_values()?,
            self.string_values()?,
            self.string_values()?,
        ];
        let labels = [self.string()?, self.string()?, self.string()?];
        Ok(
            json!({"key":key,"schema_name":schema,"properties":properties,"schema_reference":schema_reference,"guid_bytes_hex":guid,"saved_string_lists":saved_strings,"labels":labels,"external_resources_loaded":false}),
        )
    }
    fn json_asset(&mut self) -> Result<Value> {
        let text = self.string()?.ok_or("Saved asset JSON is null")?;
        let value: Value = serde_json::from_str(&text).map_err(|_| "Invalid saved asset JSON")?;
        let label = self.string()?;
        let count = self.count()?;
        let records = (0..count)
            .map(|_| Ok([self.string()?, self.string()?, self.string()?]))
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"saved_json":value,"label":label,"saved_string_records":records,"external_resources_loaded":false}),
        )
    }
    fn f32s<const N: usize>(&mut self) -> Result<[f32; N]> {
        let mut x = [0.; N];
        for v in &mut x {
            *v = f32::from_le_bytes(self.cursor.take(4)?.try_into().unwrap());
            if !v.is_finite() {
                return Err("Nonfinite fragment value".into());
            }
        }
        Ok(x)
    }
    fn f64(&mut self) -> Result<f64> {
        let value = f64::from_le_bytes(self.cursor.take(8)?.try_into().unwrap());
        if !value.is_finite() {
            return Err("Nonfinite fragment scalar".into());
        }
        Ok(value)
    }
    fn pointer(&mut self, expected: u32) -> Result<Option<u32>> {
        let start = self.cursor.pos;
        let id = self.cursor.u32()?;
        if id == 0 {
            return Ok(None);
        }
        if id == 1 {
            let target = self.cursor.u32()?;
            let (kind, _) = self.objects.get(&target).ok_or_else(|| {
                format!("Unresolved graph backreference {target} at {start}, expected {expected}")
            })?;
            if *kind != expected
                && !(expected == 182 && *kind == 185)
                && !(expected == 14 && *kind == 15)
            {
                return Err("Graph backreference has unexpected type".into());
            }
            if matches!(self.objects.get(&target), Some((_, Object::Pending))) {
                return Err("Cyclic or incomplete graph backreference".into());
            }
            return Ok(Some(target));
        }
        if id < 100 || self.objects.contains_key(&id) {
            return Err("Invalid or duplicate graph object identity".into());
        }
        if self.depth >= 128 || self.objects.len() >= 1_000_000 {
            return Err("Fragment object/depth budget exceeded".into());
        }
        let class = self.cursor.u32()?;
        if class != expected
            && !(expected == 182 && class == 185)
            && !(expected == 14 && class == 15)
        {
            return Err(format!(
                "Unsupported graph class {class}, expected {expected}"
            ));
        }
        // Reserve before recursive children, so a child cannot reuse its parent's ID.
        self.objects.insert(id, (class, Object::Pending));
        self.depth += 1;
        let object = match class {
            13 => Object::Fragment,
            14 => {
                self.cursor.align(8)?;
                Object::Translation([self.f64()?, self.f64()?, self.f64()?])
            }
            15 => {
                self.cursor.align(8)?;
                Object::Rigid(
                    [self.f64()?, self.f64()?, self.f64()?],
                    [self.f64()?, self.f64()?, self.f64()?, self.f64()?],
                )
            }
            54 => Object::Material(self.f32s::<14>()?),
            55 => {
                let source_flags = self.cursor.u32()?;
                if ![1, 17, 33, 49].contains(&source_flags) {
                    return Err(format!(
                        "Unsupported appearance flags {source_flags:#x}; extended material payload is not decoded"
                    ));
                }
                let material = self.pointer(54)?.ok_or("Material absent")?;
                let asset = if source_flags & 0x20 != 0 {
                    self.pointer(182)?
                } else {
                    None
                };
                Object::Appearance(source_flags, material, asset)
            }
            93 => {
                let bounds = self.f32s::<6>()?;
                self.cursor.align(8)?;
                Object::Bounds(
                    bounds,
                    [self.f64()?, self.f64()?, self.f64()?],
                    self.f32s::<1>()?[0],
                )
            }
            182 => Object::Asset(self.asset()?),
            185 => Object::Asset(self.json_asset()?),
            27 => {
                let kind = self.cursor.u32()?;
                if kind != 1 {
                    return Err("Unsupported partition light layout".into());
                }
                let asset = self.pointer(182)?;
                Object::Light(
                    json!({"kind":kind,"asset_reference":asset,"parameters":self.double_values(13)?}),
                )
            }
            183 => {
                let name = self.string()?;
                let category = self.string()?;
                let xml = self.string()?;
                let parent = self.pointer(183)?;
                Object::Schema(
                    json!({"name":name,"category":category,"xml_source":xml,"parent_reference":parent,"xml_executed":false}),
                )
            }
            _ => return Err("Unknown graph object class".into()),
        };
        self.depth -= 1;
        if let Object::Asset(value) | Object::Schema(value) | Object::Light(value) = &object {
            self.assets.push(AssetRecord {
                serialized_id: id,
                serialized_class: class,
                record_offset: start,
                record_bytes: self.cursor.pos - start,
                value: value.clone(),
            });
        }
        self.objects.insert(id, (class, object));
        Ok(Some(id))
    }
}

/// Read the structural lighting/exporter/coordinate prefix of a partition tail.
/// The remaining cache fields are preserved, not interpreted as transforms.
pub fn partition_tail(bytes: &[u8], offset: usize, seeds: Vec<(u32, u32, Value)>) -> Result<Value> {
    let mut graph = Graph {
        cursor: Cursor { bytes, pos: offset },
        objects: BTreeMap::new(),
        depth: 0,
        asset_values: 0,
        assets: vec![],
    };
    for (id, kind, value) in seeds {
        graph.objects.insert(
            id,
            (
                kind,
                if kind == 185 {
                    Object::Asset(value)
                } else {
                    Object::Pending
                },
            ),
        );
    }
    if graph.cursor.u32()? != 2 {
        return Err("Unsupported partition-tail envelope".into());
    }
    let count = graph.count()?;
    let lights = (0..count)
        .map(|_| graph.pointer(27))
        .collect::<Result<Vec<_>>>()?;
    let ambient = graph.double_values(3)?;
    let flags = graph.cursor.u32()?;
    let exporter = graph.string()?.ok_or("Partition exporter missing")?;
    let exporter_version = graph.cursor.u32()?;
    let units_offset = graph.cursor.pos;
    let code = graph.cursor.u32()?;
    let unit = match code {
        0 => Some(("m", 1.)),
        1 => Some(("cm", 0.01)),
        2 => Some(("mm", 0.001)),
        3 => Some(("ft", 0.3048)),
        4 => Some(("in", 0.0254)),
        5 => Some(("yd", 0.9144)),
        6 => Some(("km", 1000.)),
        7 => Some(("mi", 1609.344)),
        8 => Some(("um", 0.000001)),
        9 => Some(("mil", 0.0000254)),
        10 => Some(("uin", 0.0000000254)),
        _ => None,
    };
    let frame_flags = graph.cursor.u32()?;
    if frame_flags != 1 {
        return Err("Unsupported partition coordinate frame".into());
    }
    let up = graph.double_values(3)?;
    let north = graph.double_values(3)?;
    Ok(
        json!({"status":"exporter_units_and_axes_decoded_cache_tail_unread","lights":lights,"lighting_records":graph.assets,"ambient_raw":ambient,"raw_flags":flags,
        "exporter":exporter,"exporter_version":exporter_version,"units":{"status":if unit.is_some(){"decoded"}else{"unknown_unit_code"},"code":code,"unit":unit.map(|v|v.0),"scale_to_m":unit.map(|v|v.1),"record_offset":units_offset},
        "up":up,"north":north,"unread_tail_offset":graph.cursor.pos,"unread_tail_hex":bytes[graph.cursor.pos..].iter().map(|b|format!("{b:02x}")).collect::<String>()}),
    )
}
#[derive(Debug, Serialize)]
pub struct Fragment {
    pub index: usize,
    pub serialized_id: u32,
    pub record_offset: usize,
    pub record_bytes: usize,
    pub geometry_index: usize,
    pub primitive_count: u32,
    pub geometry_kind: u32,
    pub flags: u32,
    pub owner_reference: u32,
    pub material_raw: [f32; 14],
    pub translation: [f64; 3],
    pub bounds_source_units: [f32; 6],
    pub geometry_origin: [f64; 3],
    pub placement_matrix_source_units: [f64; 16],
    pub bounds_auxiliary_scalar: f32,
    pub scalar_raw: f64,
    pub opaque_word: u32,
    pub appearance_flags: u32,
    pub appearance_serialized_id: u32,
    pub material_serialized_id: u32,
    pub extended_material_serialized_id: Option<u32>,
    pub transform_serialized_id: Option<u32>,
    pub bounds_serialized_id: u32,
    pub primitive_count_matches: bool,
    pub local_bounds_match: bool,
    pub status: String,
}
#[derive(Debug, Serialize)]
pub struct Fragments {
    pub declared: usize,
    pub decoded: usize,
    pub trailing_bytes: usize,
    pub diagnostic: Option<String>,
    pub rows: Vec<Fragment>,
    pub assets: Vec<AssetRecord>,
}
pub fn read_fragments(container: &Container, geometry: &[MeshDefinition]) -> Result<Fragments> {
    let block = container
        .blocks
        .iter()
        .find(|b| b.entry.name.ends_with("\\LcOpNwdFragments"))
        .ok_or("Fragment stream absent")?;
    read_fragments_in(block, geometry)
}
pub fn read_fragments_in(block: &Block, geometry: &[MeshDefinition]) -> Result<Fragments> {
    let mut graph = Graph {
        cursor: Cursor::new(&block.body),
        objects: BTreeMap::new(),
        depth: 0,
        asset_values: 0,
        assets: vec![],
    };
    let declared = graph.cursor.u32()? as usize;
    if declared > 1_000_000 {
        return Err("Fragment budget exceeded".into());
    }
    let mut rows = Vec::new();
    let mut diagnostic = None;
    for index in 0..declared {
        let start = graph.cursor.pos;
        let next: Result<Fragment> = (|| {
            if graph.cursor.bytes.get(start..start + 4) == Some(&1u32.to_le_bytes()) {
                return Err("Referenced fragment records are not supported in this subset".into());
            }
            let id = graph.pointer(13)?.ok_or("Null fragment")?;
            graph.cursor.align(8)?;
            let factor = graph.f64()?;
            let primitive_count = graph.cursor.u32()?;
            let kind = graph.cursor.u32()?;
            let flags = graph.cursor.u32()?;
            let owner = graph.cursor.u32()?;
            let transform = graph.pointer(14)?;
            let appearance = graph.pointer(55)?.ok_or("Appearance missing")?;
            let placement = graph.pointer(93)?.ok_or("Bounds missing")?;
            let opaque_word = graph.cursor.u32()?;
            let geometry_index = graph
                .cursor
                .u32()?
                .checked_sub(1)
                .ok_or("Zero geometry reference")? as usize;
            let mesh = geometry
                .get(geometry_index)
                .ok_or("Geometry reference outside directory")?;
            let (appearance_flags, material_id, extended_material_serialized_id) =
                match graph.objects.get(&appearance) {
                    Some((_, Object::Appearance(flags, id, asset))) => (*flags, *id, *asset),
                    _ => return Err("Unexpected appearance object".into()),
                };
            let material = match graph.objects.get(&material_id) {
                Some((_, Object::Material(values))) => *values,
                _ => return Err("Unexpected material object".into()),
            };
            let (bounds, geometry_origin, bounds_auxiliary_scalar) = match graph
                .objects
                .get(&placement)
            {
                Some((_, Object::Bounds(bounds, origin, scalar))) => (*bounds, *origin, *scalar),
                _ => return Err("Unexpected bounds object".into()),
            };
            let (translation, quaternion) = match transform.and_then(|id| graph.objects.get(&id)) {
                Some((_, Object::Translation(v))) => (*v, [0., 0., 0., 1.]),
                Some((_, Object::Rigid(v, q))) => (*v, *q),
                None => (geometry_origin, [0., 0., 0., 1.]),
                _ => return Err("Unsupported placement".into()),
            };
            let placement_matrix_source_units = rigid_matrix(translation, quaternion)?;
            let mut lower = [f32::INFINITY; 3];
            let mut upper = [f32::NEG_INFINITY; 3];
            for point in &mesh.definition.positions {
                for k in 0..3 {
                    lower[k] = lower[k].min(point[k]);
                    upper[k] = upper[k].max(point[k]);
                }
            }
            let local_bounds_match = (0..3).all(|k| {
                (lower[k] - bounds[k]).abs() < 1e-4 && (upper[k] - bounds[k + 3]).abs() < 1e-4
            });
            let primitive_count_matches = if kind == 4 && mesh.definition.serialized_class == 94 {
                mesh.triangles.len() == primitive_count as usize
            } else if kind == 8 && mesh.definition.serialized_class == 95 {
                mesh.lines.len() == primitive_count as usize
            } else {
                false
            };
            Ok(Fragment {
                index,
                serialized_id: id,
                record_offset: start,
                record_bytes: graph.cursor.pos - start,
                geometry_index,
                primitive_count,
                geometry_kind: kind,
                flags,
                owner_reference: owner,
                material_raw: material,
                translation,
                bounds_source_units: bounds,
                geometry_origin,
                placement_matrix_source_units,
                bounds_auxiliary_scalar,
                scalar_raw: factor,
                opaque_word,
                appearance_flags,
                appearance_serialized_id: appearance,
                material_serialized_id: material_id,
                extended_material_serialized_id,
                transform_serialized_id: transform,
                bounds_serialized_id: placement,
                primitive_count_matches,
                local_bounds_match,
                status: if local_bounds_match && primitive_count_matches {
                    "decoded_requires_review"
                } else {
                    "consistency_question"
                }
                .into(),
            })
        })();
        match next {
            Ok(row) => rows.push(row),
            Err(error) => {
                diagnostic = Some(format!("Fragment {index} at {start}: {error}"));
                break;
            }
        }
    }
    let trailing = block.body.len() - graph.cursor.pos;
    if diagnostic.is_none()
        && (trailing > 7 || block.body[graph.cursor.pos..].iter().any(|b| *b != 0))
    {
        diagnostic = Some("Unparsed fragment suffix".into())
    }
    Ok(Fragments {
        declared,
        decoded: rows.len(),
        trailing_bytes: trailing,
        diagnostic,
        rows,
        assets: graph.assets,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translation_backreference_preserves_values_and_type() {
        let mut b = Vec::new();
        for n in [100u32, 14] {
            b.extend(n.to_le_bytes())
        }
        for x in [1.25f64, -3.5, 0.75] {
            b.extend(x.to_le_bytes())
        }
        for n in [1u32, 100, 1, 100] {
            b.extend(n.to_le_bytes())
        }
        let mut g = Graph {
            cursor: Cursor::new(&b),
            objects: BTreeMap::new(),
            depth: 0,
            asset_values: 0,
            assets: vec![],
        };
        assert_eq!(g.pointer(14).unwrap(), Some(100));
        assert_eq!(g.pointer(14).unwrap(), Some(100));
        assert!(matches!(
            g.objects.get(&100),
            Some((14, Object::Translation([1.25, -3.5, 0.75])))
        ));
        assert!(g.pointer(54).unwrap_err().contains("unexpected type"));
    }
    #[test]
    fn unresolved_reference_is_not_a_null_transform() {
        let b = [1u32.to_le_bytes(), 999u32.to_le_bytes()].concat();
        let mut g = Graph {
            cursor: Cursor::new(&b),
            objects: BTreeMap::new(),
            depth: 0,
            asset_values: 0,
            assets: vec![],
        };
        assert!(g.pointer(14).unwrap_err().contains("Unresolved"));
    }
    #[test]
    fn xyzw_quarter_turn_preserves_translation_and_rejects_invalid_rotations() {
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let m = rigid_matrix([10., 20., 30.], [0., 0., h, h]).unwrap();
        // A point on local +X must rotate to world +Y, then translate once.
        for (actual, wanted) in [
            (m[0] + m[12], 10.),
            (m[1] + m[13], 21.),
            (m[2] + m[14], 30.),
        ] {
            assert!((actual - wanted).abs() < 1e-12);
        }
        assert!(rigid_matrix([0.; 3], [0.; 4]).is_err());
        assert!(rigid_matrix([f64::NAN, 0., 0.], [0., 0., 0., 1.]).is_err());
    }
    #[test]
    fn bounds_origin_is_three_aligned_doubles_not_seven_floats() {
        let mut b = vec![];
        for value in [100u32, 93] {
            b.extend(value.to_le_bytes());
        }
        for value in [0f32, 0., 0., 1., 2., 3.] {
            b.extend(value.to_le_bytes());
        }
        for value in [1e10f64, -12345.6789, 0.25] {
            b.extend(value.to_le_bytes());
        }
        b.extend(1.5f32.to_le_bytes());
        let mut g = Graph {
            cursor: Cursor::new(&b),
            objects: BTreeMap::new(),
            depth: 0,
            asset_values: 0,
            assets: vec![],
        };
        assert_eq!(g.pointer(93).unwrap(), Some(100));
        match &g.objects[&100].1 {
            Object::Bounds(bounds, origin, scalar) => {
                assert_eq!(*bounds, [0., 0., 0., 1., 2., 3.]);
                assert_eq!(*origin, [1e10, -12345.6789, 0.25]);
                assert_eq!(*scalar, 1.5);
            }
            _ => panic!("wrong object type"),
        }
        assert_eq!(g.cursor.pos, b.len());
    }
}
