//! Synthetic fixtures; contains no copied project data.
use crate::*;
use flate2::{Compression, write::ZlibEncoder};
use std::io::Write;
pub fn u32v(out: &mut Vec<u8>, x: u32) {
    out.extend(x.to_le_bytes())
}
pub fn align(out: &mut Vec<u8>, n: usize) {
    out.resize(out.len().div_ceil(n) * n, 0)
}
pub fn zip(bytes: &[u8]) -> Vec<u8> {
    let mut w = ZlibEncoder::new(Vec::new(), Compression::default());
    w.write_all(bytes).unwrap();
    w.finish().unwrap()
}
pub fn envelope(entries: Vec<(String, u32, Vec<u8>, u32, u32)>) -> Vec<u8> {
    let mut file = OUTER.to_vec();
    let mut directory = Vec::new();
    u32v(&mut directory, u32::MAX);
    u32v(&mut directory, entries.len() as u32);
    for (name, encoding, raw, prefix, tail) in entries {
        u32v(&mut directory, name.len() as u32);
        directory.extend(name.bytes());
        align(&mut directory, 4);
        u32v(&mut directory, encoding);
        align(&mut directory, 8);
        directory.extend((file.len() as u64).to_le_bytes());
        directory.extend((raw.len() as u64).to_le_bytes());
        u32v(&mut directory, prefix);
        u32v(&mut directory, tail);
        file.extend(raw);
    }
    let offset = file.len();
    file.extend(b"#LcUStream-V1.1 binary double release utf8 navisworks:431 lizlib\n");
    file.extend([0; 7]);
    file.extend(zip(&directory));
    file.extend([0; 8]);
    file.extend((offset as u64).to_le_bytes());
    file.extend(OUTER);
    file
}
pub fn geometry_record() -> Vec<u8> {
    let mut b = Vec::new();
    for v in [100, 94, 101, 60, 3, 9] {
        u32v(&mut b, v)
    }
    for v in [0f32, 0., 0., 1., 0., 0., 0., 1., 0.] {
        b.extend(v.to_le_bytes())
    }
    for v in [1, 2, 1, 0xc0000000] {
        u32v(&mut b, v)
    }
    align(&mut b, 8);
    b
}
pub fn fragment_record() -> Vec<u8> {
    let mut b = Vec::new();
    for v in [1, 100, 13] {
        u32v(&mut b, v)
    }
    align(&mut b, 8);
    b.extend(1f64.to_le_bytes());
    for v in [1, 4, 0, 123, 0, 101, 55, 17, 102, 54] {
        u32v(&mut b, v)
    }
    for v in [1f32, 1., 1., 1., 1., 1., 0., 0., 0., 0., 0., 0., 0., 0.] {
        b.extend(v.to_le_bytes())
    }
    for v in [103, 93] {
        u32v(&mut b, v)
    }
    for v in [0f32, 0., 0., 1., 1., 0.] {
        b.extend(v.to_le_bytes())
    }
    align(&mut b, 8);
    for v in [0f32, 0., 0., 0., 0., 0., 1.] {
        b.extend(v.to_le_bytes())
    }
    u32v(&mut b, 0x7fc00000);
    u32v(&mut b, 1);
    align(&mut b, 8);
    b
}
pub fn scene(record: Vec<u8>, fragment: Vec<u8>) -> Vec<u8> {
    let zipped = zip(&record);
    let mut appendix = Vec::new();
    for v in [1, 1, zipped.len() as u32, record.len() as u32] {
        u32v(&mut appendix, v)
    }
    let tail = zip(&appendix);
    let mut raw = vec![0; 4];
    raw.extend(zipped);
    raw.extend(&tail);
    envelope(vec![
        (
            "synthetic\\LcOpNwdGeometry".into(),
            1,
            raw,
            4,
            tail.len() as u32,
        ),
        (
            "synthetic\\LcOpNwdFragments".into(),
            1,
            zip(&fragment),
            0,
            0,
        ),
    ])
}
