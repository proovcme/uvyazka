//! Serialized fragment graph subset with typed references and raw provenance.
use crate::geometry::MeshDefinition;
use crate::{Container, Cursor, Result};
use serde::Serialize;
use std::collections::BTreeMap;
#[derive(Debug, Clone)]
enum Object {
    Pending,
    Fragment,
    Translation([f64; 3]),
    Material([f32; 14]),
    Appearance(u32, u32),
    Bounds([f32; 6], [f32; 7]),
}
struct Graph<'a> {
    cursor: Cursor<'a>,
    objects: BTreeMap<u32, (u32, Object)>,
}
impl Graph<'_> {
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
        let id = self.cursor.u32()?;
        if id == 0 {
            return Ok(None);
        }
        if id == 1 {
            let target = self.cursor.u32()?;
            let (kind, _) = self
                .objects
                .get(&target)
                .ok_or("Unresolved graph backreference")?;
            if *kind != expected {
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
        let class = self.cursor.u32()?;
        if class != expected {
            return Err(format!(
                "Unsupported graph class {class}, expected {expected}"
            ));
        }
        // Reserve before recursive children, so a child cannot reuse its parent's ID.
        self.objects.insert(id, (class, Object::Pending));
        let object = match class {
            13 => Object::Fragment,
            14 => {
                self.cursor.align(8)?;
                Object::Translation([self.f64()?, self.f64()?, self.f64()?])
            }
            54 => Object::Material(self.f32s::<14>()?),
            55 => {
                let source_flags = self.cursor.u32()?;
                if ![1, 17].contains(&source_flags) {
                    return Err(format!(
                        "Unsupported appearance flags {source_flags:#x}; extended material payload is not decoded"
                    ));
                }
                Object::Appearance(source_flags, self.pointer(54)?.ok_or("Material absent")?)
            }
            93 => {
                let bounds = self.f32s::<6>()?;
                self.cursor.align(8)?;
                Object::Bounds(bounds, self.f32s::<7>()?)
            }
            _ => return Err("Unknown graph object class".into()),
        };
        self.objects.insert(id, (class, object));
        Ok(Some(id))
    }
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
    pub auxiliary_values: [f32; 7],
    pub scalar_raw: f64,
    pub opaque_word: u32,
    pub appearance_flags: u32,
    pub appearance_serialized_id: u32,
    pub material_serialized_id: u32,
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
}
pub fn read_fragments(container: &Container, geometry: &[MeshDefinition]) -> Result<Fragments> {
    let block = container
        .blocks
        .iter()
        .find(|b| b.entry.name.ends_with("\\LcOpNwdFragments"))
        .ok_or("Fragment stream absent")?;
    let mut graph = Graph {
        cursor: Cursor::new(&block.body),
        objects: BTreeMap::new(),
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
            let (appearance_flags, material_id) = match graph.objects.get(&appearance) {
                Some((_, Object::Appearance(flags, id))) => (*flags, *id),
                _ => return Err("Unexpected appearance object".into()),
            };
            let material = match graph.objects.get(&material_id) {
                Some((_, Object::Material(values))) => *values,
                _ => return Err("Unexpected material object".into()),
            };
            let translation = match transform.and_then(|id| graph.objects.get(&id)) {
                Some((_, Object::Translation(values))) => *values,
                None => [0.; 3],
                _ => return Err("Unsupported placement".into()),
            };
            let (bounds, aux) = match graph.objects.get(&placement) {
                Some((_, Object::Bounds(bounds, aux))) => (*bounds, *aux),
                _ => return Err("Unexpected bounds object".into()),
            };
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
                auxiliary_values: aux,
                scalar_raw: factor,
                opaque_word,
                appearance_flags,
                appearance_serialized_id: appearance,
                material_serialized_id: material_id,
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
        };
        assert!(g.pointer(14).unwrap_err().contains("Unresolved"));
    }
}
