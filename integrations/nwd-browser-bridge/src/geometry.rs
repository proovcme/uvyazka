//! Typed geometry subset observed in serialization 431; no guessed faces.
use crate::{Container, Cursor, GeometryDefinition, Result, checked_slice, geometry_definitions};
use serde::Serialize;
#[derive(Debug, Serialize)]
pub struct MeshDefinition {
    #[serde(flatten)]
    pub definition: GeometryDefinition,
    pub indices: Vec<u32>,
    pub strips: Vec<u32>,
    pub triangles: Vec<[u32; 3]>,
    pub lines: Vec<[u32; 2]>,
    pub strip_table_offset: usize,
    pub diagnostic: Option<String>,
}
fn indices(raw: &[u8], position: &mut usize, count: usize, vertices: usize) -> Result<Vec<u32>> {
    if count > 3_000_000 || vertices == 0 {
        return Err("Invalid bounded index count".into());
    }
    if count == vertices {
        return Ok((0..count as u32).collect());
    }
    let mut out = Vec::with_capacity(count);
    let mut fresh = 0u32;
    while out.len() < count {
        let code = *raw.get(*position).ok_or("Truncated geometry index code")?;
        *position += 1;
        match code {
            0..=63 => {
                let n = code as usize + 1;
                if out.len() + n > count || fresh as usize + n > vertices {
                    return Err("New-vertex run exceeds declared array".into());
                }
                out.extend(fresh..fresh + n as u32);
                fresh += n as u32;
            }
            64..=127 => {
                let distance = (code - 64) as usize;
                if distance == 0 || distance > out.len() {
                    return Err("Index history reference outside decoded prefix".into());
                }
                out.push(out[out.len() - distance]);
            }
            128 => {
                out.push(*out.last().ok_or("Repeat before first index")?);
            }
            224..=239 => {
                let next = *raw
                    .get(*position)
                    .ok_or("Truncated long history reference")?;
                *position += 1;
                let distance = (((code - 224) as usize) << 8) | next as usize;
                if distance == 0 || distance > out.len() {
                    return Err("Long index history reference outside decoded prefix".into());
                }
                out.push(out[out.len() - distance]);
            }
            240..=255 => {
                let next = checked_slice(raw, *position, 2)?;
                *position += 2;
                let index =
                    (((code - 240) as u32) << 16) | ((next[0] as u32) << 8) | next[1] as u32;
                if index as usize >= vertices {
                    return Err("Literal geometry index outside vertex pool".into());
                }
                out.push(index);
            }
            _ => return Err(format!("Unsupported geometry index code {code:#x}")),
        }
    }
    if fresh as usize != vertices {
        return Err("New-vertex runs do not cover declared vertex pool".into());
    }
    Ok(out)
}
fn packed_lengths(
    raw: &[u8],
    start: usize,
    count: usize,
    bits: usize,
) -> Result<(Vec<u32>, usize)> {
    if count > 1_000_000 || !(1..=16).contains(&bits) {
        return Err("Invalid packed length vector".into());
    }
    let words = (count * bits).div_ceil(32);
    let bytes = checked_slice(raw, start, words * 4)?;
    let words: Vec<_> = bytes
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let mut values = Vec::with_capacity(count);
    for i in 0..count {
        let mut value = 0;
        for bit in 0..bits {
            let offset = i * bits + bit;
            value = (value << 1) | ((words[offset / 32] >> (31 - offset % 32)) & 1)
        }
        values.push(value);
    }
    Ok((values, start + words.len() * 4))
}
fn strips(raw: &[u8], start: usize, total: usize, minimum: u32) -> Result<(Vec<u32>, usize)> {
    let mut found = Vec::new();
    for offset in ((start + 3) / 4 * 4..raw.len().saturating_sub(12)).step_by(4) {
        let mut cursor = Cursor {
            bytes: raw,
            pos: offset,
        };
        let n = cursor.u32()? as usize;
        let bits = cursor.u32()? as usize;
        let duplicate = cursor.u32()? as usize;
        if n != duplicate
            || n == 0
            || n > total
            || !(1..=16).contains(&bits)
            || offset + 12 + (n * bits).div_ceil(32) * 4 > raw.len()
        {
            continue;
        }
        let (values, end) = packed_lengths(raw, offset + 12, n, bits)?;
        if raw.len() - end <= 15
            && values.iter().all(|n| *n >= minimum)
            && values.iter().map(|n| *n as usize).sum::<usize>() == total
            && raw[end..].iter().all(|b| *b == 0)
        {
            found.push((values, offset));
        }
    }
    if found.len() != 1 {
        return Err(format!(
            "Strip-length layout unresolved ({} candidates)",
            found.len()
        ));
    }
    Ok(found.remove(0))
}
pub fn read_geometry(container: &Container) -> Result<Vec<MeshDefinition>> {
    let definitions = geometry_definitions(container)?;
    let block = container
        .blocks
        .iter()
        .find(|b| b.entry.name.ends_with("\\LcOpNwdGeometry"))
        .ok_or("Geometry stream absent")?;
    let mut output = Vec::new();
    for mut definition in definitions {
        let raw = checked_slice(
            &block.body,
            definition.record_offset,
            definition.record_bytes,
        )?;
        let mut pos = 24 + definition.positions.len() * 12;
        let projected = (|| {
            let index = indices(
                raw,
                &mut pos,
                definition.index_count,
                definition.positions.len(),
            )?;
            let (lengths, strip_offset) = strips(
                raw,
                pos,
                definition.index_count,
                if definition.serialized_class == 94 {
                    3
                } else {
                    2
                },
            )?;
            let mut triangles = Vec::new();
            let mut lines = Vec::new();
            let mut base = 0;
            for n in &lengths {
                let n = *n as usize;
                if definition.serialized_class == 94 {
                    for i in 0..n - 2 {
                        let mut t = [index[base + i], index[base + i + 1], index[base + i + 2]];
                        if i % 2 == 1 {
                            t.swap(0, 1)
                        }
                        triangles.push(t)
                    }
                } else {
                    for i in 0..n - 1 {
                        lines.push([index[base + i], index[base + i + 1]])
                    }
                }
                base += n;
            }
            Ok((index, lengths, triangles, lines, strip_offset))
        })();
        match projected {
            Ok((indices, strips, triangles, lines, strip_table_offset)) => {
                definition.status = "decoded_geometry_requires_review";
                output.push(MeshDefinition {
                    definition,
                    indices,
                    strips,
                    triangles,
                    lines,
                    strip_table_offset,
                    diagnostic: None,
                })
            }
            Err(e) => {
                definition.status = "vertices_only_unsupported_index_layout";
                output.push(MeshDefinition {
                    definition,
                    indices: Vec::new(),
                    strips: Vec::new(),
                    triangles: Vec::new(),
                    lines: Vec::new(),
                    strip_table_offset: 0,
                    diagnostic: Some(e),
                })
            }
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn index_codes_preserve_new_history_repeat_and_literal() {
        let bytes = [3, 67, 240, 0, 0, 1, 66, 66, 128];
        let mut pos = 0;
        assert_eq!(
            indices(&bytes, &mut pos, 11, 6).unwrap(),
            [0, 1, 2, 3, 1, 0, 4, 5, 4, 5, 5]
        );
        assert_eq!(pos, bytes.len());
    }
    #[test]
    fn corrupt_index_does_not_make_a_face() {
        for bytes in [
            vec![64],
            vec![66],
            vec![128],
            vec![224],
            vec![240, 0],
            vec![63],
        ] {
            assert!(indices(&bytes, &mut 0, 3, 2).is_err());
        }
    }
    #[test]
    fn packed_words_are_little_endian_with_most_significant_bits_first() {
        let bytes = 0x44444534u32.to_le_bytes();
        assert_eq!(
            packed_lengths(&bytes, 0, 8, 4).unwrap().0,
            [4, 4, 4, 4, 4, 5, 3, 4]
        );
    }
}
