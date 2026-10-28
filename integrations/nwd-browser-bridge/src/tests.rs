use crate::fixtures::*;
use crate::*;
use crate::{fragments::read_fragments, geometry::read_geometry};

#[test]
fn synthetic_scene_roundtrip_has_source_and_opaque_bits() {
    let source = scene(geometry_record(), fragment_record());
    let c = read_container(&source).unwrap();
    assert_eq!(c.source_sha256, hash(&source));
    assert!(c.unassigned_source_ranges.is_empty());
    let g = geometry::read_geometry(&c).unwrap();
    assert_eq!(g[0].triangles, [[0, 1, 2]]);
    let f = fragments::read_fragments(&c, &g).unwrap();
    assert_eq!(f.decoded, 1);
    assert!(f.diagnostic.is_none());
    assert!(f.rows[0].local_bounds_match);
    assert!(f.rows[0].primitive_count_matches);
    assert_eq!(f.rows[0].opaque_word, 0x7fc00000);
    assert_eq!(f.rows[0].material_serialized_id, 102);
    assert_eq!(f.rows[0].appearance_flags, 17);
    let json = serde_json::to_string(&f).unwrap();
    assert!(!json.contains("NaN"));
}
#[test]
fn truncated_container_and_pointer_never_panic() {
    let source = scene(geometry_record(), fragment_record());
    for n in 0..source.len() {
        assert!(read_container(&source[..n]).is_err(), "prefix {n}");
    }
    for pointer in [0, 1, 51, source.len() as u64, u64::MAX] {
        let mut b = source.clone();
        let p = b.len() - OUTER.len() - 8;
        b[p..p + 8].copy_from_slice(&pointer.to_le_bytes());
        assert!(read_container(&b).is_err());
    }
}
#[test]
fn truncated_directory_prelude_is_an_error() {
    let mut b = OUTER.to_vec();
    let offset = b.len();
    b.extend(b"#LcUStream-V1.1 binary double release utf8 navisworks:431 lizlib\n");
    b.extend((offset as u64).to_le_bytes());
    b.extend(OUTER);
    assert!(read_container(&b).is_err());
}
#[test]
fn unsupported_inner_version_is_not_silently_read() {
    let mut b = scene(geometry_record(), fragment_record());
    let pos = b.windows(3).position(|s| s == b"431").unwrap();
    b[pos..pos + 3].copy_from_slice(b"999");
    assert!(
        read_container(&b)
            .unwrap_err()
            .contains("Unsupported inner")
    );
}
#[test]
fn duplicate_directory_names_are_rejected() {
    let b = envelope(vec![
        ("same".into(), 1, zip(b"a"), 0, 0),
        ("same".into(), 1, zip(b"b"), 0, 0),
    ]);
    assert!(read_container(&b).unwrap_err().contains("duplicate"));
}
#[test]
fn invalid_envelope_sizes_are_rejected() {
    let b = envelope(vec![("bad".into(), 1, zip(b"ok"), 9999, 1)]);
    assert!(read_container(&b).is_err());
}
#[test]
fn unknown_encoding_remains_opaque() {
    let b = envelope(vec![("opaque".into(), 77, vec![1, 2, 3], 0, 0)]);
    let c = read_container(&b).unwrap();
    assert_eq!(c.blocks[0].status, "opaque_encoding");
    assert!(c.blocks[0].body.is_empty());
}
#[test]
fn zlib_checksum_error_remains_visible() {
    let mut z = zip(b"not a model");
    let last = z.len() - 1;
    z[last] ^= 1;
    let b = envelope(vec![("corrupt".into(), 1, z, 0, 0)]);
    let c = read_container(&b).unwrap();
    assert_eq!(c.blocks[0].status, "error");
    assert!(
        c.blocks[0]
            .diagnostic
            .as_ref()
            .unwrap()
            .contains("Zlib integrity")
    );
}
#[test]
fn corrupt_or_unknown_bounded_geometry_keeps_the_next_reference_slot() {
    for mutate in [0usize, 1] {
        let mut bad = geometry_record();
        if mutate == 0 {
            bad[4..8].copy_from_slice(&999u32.to_le_bytes());
        } else {
            bad[24..28].copy_from_slice(&f32::NAN.to_le_bytes());
        }
        let c = read_container(&scene_records(
            vec![geometry_record(), bad, geometry_record()],
            fragment_record(),
        ))
        .unwrap();
        let geometry = read_geometry(&c).unwrap();
        assert_eq!(geometry.len(), 3);
        assert!(geometry[0].diagnostic.is_none());
        assert!(geometry[1].diagnostic.is_some());
        assert!(geometry[1].definition.positions.is_empty());
        assert_eq!(geometry[2].definition.index, 2);
        assert_eq!(geometry[2].triangles.len(), 1);
    }
}
#[test]
fn bad_semantic_fragment_reference_keeps_the_following_complete_record() {
    let first = fragment_record();
    let c = read_container(&scene(geometry_record(), first.clone())).unwrap();
    let geometry = read_geometry(&c).unwrap();
    let f = read_fragments(&c, &geometry).unwrap();
    let end = f.rows[0].record_offset + f.rows[0].record_bytes;
    let mut second = first[4..end].to_vec();
    for (id, class, new_id) in [
        (100u32, 13u32, 104u32),
        (101, 55, 105),
        (102, 54, 106),
        (103, 93, 107),
    ] {
        let pattern = [id.to_le_bytes(), class.to_le_bytes()].concat();
        let at = second.windows(8).position(|p| p == pattern).unwrap();
        second[at..at + 4].copy_from_slice(&new_id.to_le_bytes());
    }
    for mutation in 0..4 {
        let mut raw = first[..end].to_vec();
        raw[..4].copy_from_slice(&2u32.to_le_bytes());
        match mutation {
            0 => raw[end - 4..end].copy_from_slice(&999u32.to_le_bytes()),
            1 => raw[end - 4..end].copy_from_slice(&0u32.to_le_bytes()),
            2 => raw[16..24].copy_from_slice(&f64::NAN.to_le_bytes()),
            _ => raw[end - 36..end - 28].copy_from_slice(&f64::INFINITY.to_le_bytes()),
        }
        raw.extend(&second);
        let c = read_container(&scene(geometry_record(), raw)).unwrap();
        let rows = read_fragments(&c, &read_geometry(&c).unwrap()).unwrap();
        assert_eq!(rows.decoded, 2);
        assert!(rows.diagnostic.is_none(), "{:?}", rows.diagnostic);
        assert!(rows.rows[0].diagnostic.is_some(), "mutation {mutation}");
        if mutation == 1 {
            assert_eq!(rows.rows[0].geometry_index, None);
        }
        if mutation == 3 {
            assert_eq!(rows.rows[0].placement_matrix_source_units, None);
        }
        assert_eq!(rows.rows[1].serialized_id, 104);
        assert!(rows.rows[1].diagnostic.is_none());
        assert!(rows.rows[1].local_bounds_match);
        assert!(!serde_json::to_string(&rows).unwrap().contains("NaN"));
    }
}
#[test]
fn concatenated_zlib_members_preserve_offsets() {
    let first = zip(b"first");
    let mut z = first.clone();
    z.extend(zip(b"second"));
    let b = envelope(vec![("stream".into(), 1, z, 0, 0)]);
    let c = read_container(&b).unwrap();
    assert_eq!(c.blocks[0].body, b"firstsecond");
    assert_eq!(c.blocks[0].segments[1].output_offset, 5);
    assert_eq!(
        c.blocks[0].segments[1].file_offset,
        OUTER.len() + first.len()
    );
}
#[test]
fn decompression_budget_is_enforced() {
    let z = zip(&vec![0; 100_000]);
    assert!(inflate_one(&z, 64).unwrap_err().contains("budget"));
    assert!(inflate_one(&z[..z.len() - 1], 100_000).is_err());
}
#[test]
fn every_truncated_fragment_is_partial_not_success() {
    let original = fragment_record();
    for n in 0..original.len() - 7 {
        let b = scene(geometry_record(), original[..n].to_vec());
        let c = read_container(&b).unwrap();
        let g = geometry::read_geometry(&c).unwrap();
        if let Ok(f) = fragments::read_fragments(&c, &g) {
            assert!(f.diagnostic.is_some() || f.decoded == 0, "prefix {n}");
        }
    }
}
#[test]
fn nonexistent_geometry_reference_is_not_substituted() {
    let mut f = fragment_record();
    let pos = f.len() - 4; // fixture ends on an eight-byte boundary; locate the explicit reference before padding
    let reference = f
        .windows(8)
        .rposition(|s| s == [0, 0, 192, 127, 1, 0, 0, 0])
        .unwrap()
        + 4;
    f[reference..reference + 4].copy_from_slice(&99u32.to_le_bytes());
    let _ = pos;
    let c = read_container(&scene(geometry_record(), f)).unwrap();
    let g = geometry::read_geometry(&c).unwrap();
    let r = fragments::read_fragments(&c, &g).unwrap();
    assert_eq!(r.decoded, 1);
    assert_eq!(r.rows[0].geometry_index, Some(98));
    assert!(
        r.rows[0]
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("outside directory")
    );
    assert!(!r.rows[0].primitive_count_matches);
}
#[test]
fn altered_declared_primitive_count_creates_question() {
    let mut f = fragment_record();
    f[24..28].copy_from_slice(&2u32.to_le_bytes());
    let c = read_container(&scene(geometry_record(), f)).unwrap();
    let g = geometry::read_geometry(&c).unwrap();
    let r = fragments::read_fragments(&c, &g).unwrap();
    assert_eq!(r.decoded, 1);
    assert!(!r.rows[0].primitive_count_matches);
    assert_eq!(r.rows[0].status, "consistency_question");
}
#[test]
fn child_cannot_reuse_parent_object_id() {
    let mut f = fragment_record();
    let i = f
        .windows(8)
        .position(|s| s == [102, 0, 0, 0, 54, 0, 0, 0])
        .unwrap();
    f[i..i + 4].copy_from_slice(&101u32.to_le_bytes());
    let c = read_container(&scene(geometry_record(), f)).unwrap();
    let g = geometry::read_geometry(&c).unwrap();
    let r = fragments::read_fragments(&c, &g).unwrap();
    assert_eq!(r.decoded, 0);
    assert!(r.diagnostic.unwrap().contains("duplicate"));
}
#[test]
fn unsupported_geometry_does_not_make_a_mesh() {
    let mut g = geometry_record();
    g[4..8].copy_from_slice(&999u32.to_le_bytes());
    let c = read_container(&scene(g, fragment_record())).unwrap();
    let records = geometry::read_geometry(&c).unwrap();
    assert!(
        records[0]
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("Unsupported geometry")
    );
    assert!(records[0].triangles.is_empty());
}
#[test]
fn nonfinite_fixed_size_material_does_not_stop_geometry_or_placements() {
    let mut fragment = fragment_record();
    let pattern = [102u32.to_le_bytes(), 54u32.to_le_bytes()].concat();
    let at = fragment.windows(8).position(|p| p == pattern).unwrap() + 8;
    fragment[at..at + 4].copy_from_slice(&f32::NAN.to_le_bytes());
    let c = read_container(&scene(geometry_record(), fragment)).unwrap();
    let f = read_fragments(&c, &read_geometry(&c).unwrap()).unwrap();
    assert_eq!(f.decoded, 1);
    assert!(f.diagnostic.is_none());
    assert!(f.rows[0].diagnostic.is_none());
    assert!(
        f.rows[0]
            .appearance_diagnostic
            .as_deref()
            .unwrap()
            .contains("Nonfinite")
    );
    assert!(f.rows[0].local_bounds_match);
}
#[test]
fn geometry_index_padding_and_segment_boundaries_are_validated() {
    let g = geometry_record();
    let a = zip(&g[..40]);
    let b = zip(&g[40..]);
    let mut index = Vec::new();
    for n in [1, 2, a.len() as u32, b.len() as u32, g.len() as u32] {
        u32v(&mut index, n)
    }
    align(&mut index, 8);
    let tail = zip(&index);
    let mut raw = vec![0; 4];
    raw.extend(a);
    raw.extend(b);
    raw.extend(&tail);
    let c = read_container(&envelope(vec![(
        "synthetic\\LcOpNwdGeometry".into(),
        1,
        raw,
        4,
        tail.len() as u32,
    )]))
    .unwrap();
    assert_eq!(
        geometry::read_geometry(&c).unwrap()[0].triangles,
        [[0, 1, 2]]
    );
}
#[test]
fn declared_extended_material_without_payload_is_not_a_complete_scene() {
    let mut f = fragment_record();
    let i = f
        .windows(8)
        .position(|s| s == [101, 0, 0, 0, 55, 0, 0, 0])
        .unwrap()
        + 8;
    f[i..i + 4].copy_from_slice(&49u32.to_le_bytes());
    let c = read_container(&scene(geometry_record(), f)).unwrap();
    let g = geometry::read_geometry(&c).unwrap();
    let r = fragments::read_fragments(&c, &g).unwrap();
    assert_eq!(r.decoded, 0);
    assert!(r.diagnostic.is_some());
}
#[test]
fn corrupt_strip_table_preserves_vertices_and_reports_unknown() {
    let mut g = geometry_record();
    g[60..64].copy_from_slice(&99u32.to_le_bytes());
    let c = read_container(&scene(g, fragment_record())).unwrap();
    let g = geometry::read_geometry(&c).unwrap();
    assert!(g[0].triangles.is_empty());
    assert!(g[0].diagnostic.is_some());
    let r = fragments::read_fragments(&c, &g).unwrap();
    assert!(!r.rows[0].primitive_count_matches);
}

#[test]
fn embedded_resource_is_bounded_hashed_and_never_loaded_from_its_uri() {
    use crate::fixtures::{align, u32v};
    fn text(b: &mut Vec<u8>, s: &str) {
        u32v(b, s.len() as u32);
        b.extend(s.as_bytes());
        align(b, 4)
    }
    let mut b = Vec::new();
    u32v(&mut b, 1);
    text(&mut b, "synthetic:inert");
    u32v(&mut b, 1);
    text(&mut b, "navis");
    text(&mut b, "bin");
    align(&mut b, 8);
    b.extend(3u64.to_le_bytes());
    b.extend([1, 2, 3]);
    align(&mut b, 4);
    let x = super::saved_asset_records(&mut super::Cursor::new(&b)).unwrap();
    assert_eq!(
        x[0]["representations"][0]["sha256"],
        super::hash(&[1, 2, 3])
    );
    assert_eq!(x[0]["external_resources_loaded"], false);
    for end in 0..b.len() - 1 {
        assert!(super::saved_asset_records(&mut super::Cursor::new(&b[..end])).is_err());
    }
}
