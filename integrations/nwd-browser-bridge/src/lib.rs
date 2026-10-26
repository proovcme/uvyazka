#[cfg(test)]
mod fixtures;
pub mod fragments;
pub mod geometry;
#[cfg(test)]
mod tests;
// Independent experimental NWD reader. Layouts derived from public sample bytes.
// No code from the PolyForm-licensed nwd-reader project is used here.
use flate2::{Decompress, FlushDecompress, Status};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const OUTER: &[u8] = b"#LcUStream-V1.1 binary double release C lichunk-008\n";
pub const MAX_INPUT: usize = 512 * 1024 * 1024;
pub const MAX_EXPANDED: usize = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
type Result<T> = std::result::Result<T, String>;
pub fn hash(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn checked_slice(data: &[u8], start: usize, len: usize) -> Result<&[u8]> {
    data.get(start..start.checked_add(len).ok_or("Range overflow")?)
        .ok_or_else(|| format!("Range outside source: {start}+{len}"))
}
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let b = checked_slice(self.bytes, self.pos, n)?;
        self.pos += n;
        Ok(b)
    }
    fn align(&mut self, n: usize) -> Result<()> {
        let p = self.pos.checked_add(n - 1).ok_or("Alignment overflow")? / n * n;
        let padding = self.take(p - self.pos)?;
        if padding.iter().any(|b| *b != 0) {
            return Err("Nonzero alignment padding".into());
        }
        Ok(())
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String> {
        let n = self.u32()? as usize;
        if n > 16384 {
            return Err("Directory name exceeds budget".into());
        }
        let text = std::str::from_utf8(self.take(n)?)
            .map_err(|_| "Invalid UTF8 name")?
            .to_owned();
        self.align(4)?;
        Ok(text)
    }
}
#[derive(Debug, Serialize, Clone)]
pub struct Entry {
    pub name: String,
    pub encoding: u32,
    pub file_offset: usize,
    pub compressed_bytes: usize,
    pub raw_prefix_bytes: usize,
    pub trailing_compressed_bytes: usize,
}
#[derive(Debug, Serialize, Clone)]
pub struct Segment {
    pub file_offset: usize,
    pub compressed_bytes: usize,
    pub output_offset: usize,
    pub expanded_bytes: usize,
}
#[derive(Debug, Serialize)]
pub struct Block {
    pub entry: Entry,
    pub status: String,
    pub sha256: Option<String>,
    pub expanded_bytes: usize,
    pub segments: Vec<Segment>,
    pub diagnostic: Option<String>,
    #[serde(skip)]
    pub body: Vec<u8>,
    #[serde(skip)]
    pub appendix: Vec<u8>,
}
#[derive(Debug, Serialize)]
pub struct Container {
    pub reader: &'static str,
    pub source_sha256: String,
    pub source_bytes: usize,
    pub directory_file_offset: usize,
    pub directory_header: String,
    pub directory_opaque_trailer_hex: String,
    pub blocks: Vec<Block>,
    pub unassigned_source_ranges: Vec<[usize; 2]>,
}
fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
fn inflate_one(bytes: &[u8], budget: usize) -> Result<(Vec<u8>, usize)> {
    let mut decoder = Decompress::new(true);
    let mut output = Vec::new();
    let mut input_offset = 0;
    loop {
        let mut buf = [0u8; 16384];
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let status = decoder
            .decompress(&bytes[input_offset..], &mut buf, FlushDecompress::None)
            .map_err(|e| format!("Zlib integrity error: {e}"))?;
        let used = (decoder.total_in() - before_in) as usize;
        let produced = (decoder.total_out() - before_out) as usize;
        input_offset += used;
        if output
            .len()
            .checked_add(produced)
            .ok_or("Output overflow")?
            > budget
        {
            return Err("Expanded output exceeds budget".into());
        }
        output.extend_from_slice(&buf[..produced]);
        if status == Status::StreamEnd {
            return Ok((output, input_offset));
        }
        if used == 0 && produced == 0 {
            return Err("Truncated or stalled zlib stream".into());
        }
    }
}
fn inflate_sequence(
    bytes: &[u8],
    file_offset: usize,
    budget: usize,
) -> Result<(Vec<u8>, Vec<Segment>)> {
    let mut input = 0;
    let mut result = Vec::new();
    let mut segments = Vec::new();
    while input < bytes.len() {
        if segments.len() >= MAX_ENTRIES {
            return Err("Too many compressed segments".into());
        }
        let (part, consumed) = inflate_one(&bytes[input..], budget - result.len())?;
        if consumed == 0 {
            return Err("Empty compressed segment".into());
        }
        segments.push(Segment {
            file_offset: file_offset + input,
            compressed_bytes: consumed,
            output_offset: result.len(),
            expanded_bytes: part.len(),
        });
        result.extend_from_slice(&part);
        input += consumed;
    }
    Ok((result, segments))
}
pub fn read_container(data: &[u8]) -> Result<Container> {
    if data.len() > MAX_INPUT {
        return Err("NWD input exceeds experimental 512 MiB budget".into());
    }
    if !data.starts_with(OUTER) || !data.ends_with(OUTER) {
        return Err(
            "Unsupported NWD container (expected complete lichunk-008 header/footer)".into(),
        );
    }
    let footer = data.len() - OUTER.len();
    let pointer_at = footer.checked_sub(8).ok_or("Missing directory pointer")?;
    let pointer = u64::from_le_bytes(checked_slice(data, pointer_at, 8)?.try_into().unwrap());
    let pointer = usize::try_from(pointer).map_err(|_| "Directory offset overflow")?;
    if pointer < OUTER.len() || pointer >= pointer_at {
        return Err("Directory pointer outside content".into());
    }
    let end = data[pointer..pointer_at]
        .iter()
        .position(|b| *b == b'\n')
        .ok_or("Directory header missing")?
        + pointer
        + 1;
    let header = std::str::from_utf8(&data[pointer..end])
        .map_err(|_| "Invalid directory header")?
        .to_owned();
    if header != "#LcUStream-V1.1 binary double release utf8 navisworks:431 lizlib\n" {
        return Err(format!(
            "Unsupported inner serialization: {}",
            header.trim()
        ));
    }
    // This known header ends at alignment 65. Seven zero bytes precede its zlib member.
    let zip = end.checked_add(7).ok_or("Directory range overflow")?;
    if checked_slice(data, end, 7)?.iter().any(|b| *b != 0) {
        return Err("Unsupported directory prelude".into());
    }
    let (directory, consumed) = inflate_one(
        checked_slice(
            data,
            zip,
            pointer_at
                .checked_sub(zip)
                .ok_or("Directory prelude exceeds envelope")?,
        )?,
        MAX_EXPANDED,
    )?;
    let trailer = checked_slice(data, zip + consumed, pointer_at - zip - consumed)?;
    if trailer.len() != 8 {
        return Err("Unexpected directory opaque trailer length".into());
    }
    let mut cursor = Cursor::new(&directory);
    if cursor.u32()? != u32::MAX {
        return Err("Unsupported directory version marker".into());
    }
    let count = cursor.u32()? as usize;
    if count == 0 || count > MAX_ENTRIES {
        return Err("Directory entry count outside budget".into());
    }
    let mut entries = Vec::new();
    let mut names = std::collections::BTreeSet::new();
    for _ in 0..count {
        let name = cursor.string()?;
        if name.is_empty() || !names.insert(name.clone()) {
            return Err("Empty or duplicate directory name".into());
        }
        let encoding = cursor.u32()?;
        cursor.align(8)?;
        let offset = usize::try_from(cursor.u64()?).map_err(|_| "Entry offset overflow")?;
        let length = usize::try_from(cursor.u64()?).map_err(|_| "Entry length overflow")?;
        let prefix = cursor.u32()? as usize;
        let tail = cursor.u32()? as usize;
        if offset < OUTER.len()
            || offset.checked_add(length).ok_or("Entry range overflow")? > pointer
            || prefix.checked_add(tail).ok_or("Entry envelope overflow")? > length
        {
            return Err("Entry range outside model or envelope overlap".into());
        }
        entries.push(Entry {
            name,
            encoding,
            file_offset: offset,
            compressed_bytes: length,
            raw_prefix_bytes: prefix,
            trailing_compressed_bytes: tail,
        });
    }
    if cursor.pos != directory.len() {
        return Err("Unparsed directory bytes".into());
    }
    let mut intervals: Vec<_> = entries
        .iter()
        .map(|e| [e.file_offset, e.file_offset + e.compressed_bytes])
        .collect();
    intervals.sort();
    let mut previous = OUTER.len();
    let mut gaps = Vec::new();
    for [start, end] in intervals {
        if start < previous {
            return Err("Overlapping container entries".into());
        }
        if start > previous {
            gaps.push([previous, start]);
        }
        previous = end;
    }
    if previous < pointer {
        gaps.push([previous, pointer]);
    }
    let mut expanded = directory.len();
    let mut blocks = Vec::new();
    for entry in entries {
        let raw = checked_slice(data, entry.file_offset, entry.compressed_bytes)?;
        let mut block = Block {
            entry: entry.clone(),
            status: "unread".into(),
            sha256: None,
            expanded_bytes: 0,
            segments: Vec::new(),
            diagnostic: None,
            body: Vec::new(),
            appendix: Vec::new(),
        };
        if entry.encoding == 1 {
            let primary_end = entry.compressed_bytes - entry.trailing_compressed_bytes;
            let encoded = &raw[entry.raw_prefix_bytes..primary_end];
            let result = inflate_sequence(
                encoded,
                entry.file_offset + entry.raw_prefix_bytes,
                MAX_EXPANDED - expanded,
            )
            .and_then(|(body, segments)| {
                let appendix = if entry.trailing_compressed_bytes > 0 {
                    let (b, _) = inflate_sequence(
                        &raw[primary_end..],
                        entry.file_offset + primary_end,
                        MAX_EXPANDED - expanded - body.len(),
                    )?;
                    b
                } else {
                    Vec::new()
                };
                Ok((body, appendix, segments))
            });
            match result {
                Ok((body, appendix, segments)) => {
                    expanded += body.len() + appendix.len();
                    block.sha256 = Some(hash(&body));
                    block.expanded_bytes = body.len();
                    block.body = body;
                    block.appendix = appendix;
                    block.segments = segments;
                    block.status = "inflated_not_semantically_decoded".into()
                }
                Err(error) => {
                    block.status = "error".into();
                    block.diagnostic = Some(error)
                }
            }
        } else {
            block.status = "opaque_encoding".into();
            block.diagnostic = Some(format!(
                "Encoding {} preserved without interpretation",
                entry.encoding
            ));
        }
        blocks.push(block);
    }
    Ok(Container {
        reader: "uvyazka-independent-nwd-0.1",
        source_sha256: hash(data),
        source_bytes: data.len(),
        directory_file_offset: pointer,
        directory_header: header,
        directory_opaque_trailer_hex: hex(trailer),
        blocks,
        unassigned_source_ranges: gaps,
    })
}
#[derive(Debug, Serialize)]
pub struct GeometryDefinition {
    pub index: usize,
    pub record_offset: usize,
    pub record_bytes: usize,
    pub serialized_class: u32,
    pub index_count: usize,
    pub positions: Vec<[f32; 3]>,
    pub status: &'static str,
}
pub fn geometry_definitions(container: &Container) -> Result<Vec<GeometryDefinition>> {
    let block = container
        .blocks
        .iter()
        .find(|b| b.entry.name.ends_with("\\LcOpNwdGeometry"))
        .ok_or("Geometry stream absent")?;
    if let Some(error) = &block.diagnostic {
        return Err(format!("Geometry stream unavailable: {error}"));
    }
    if block.entry.raw_prefix_bytes != 4 || block.appendix.is_empty() {
        return Err("Unsupported geometry envelope".into());
    }
    let mut c = Cursor::new(&block.appendix);
    let records = c.u32()? as usize;
    let segments = c.u32()? as usize;
    if records > MAX_ENTRIES || segments != block.segments.len() {
        return Err("Geometry directory count mismatch".into());
    }
    for segment in &block.segments {
        if c.u32()? as usize != segment.compressed_bytes {
            return Err("Geometry segment length mismatch".into());
        }
    }
    let mut lengths = Vec::new();
    for _ in 0..records {
        lengths.push(c.u32()? as usize)
    }
    // Index directory is padded to an eight-byte boundary (Chair has one zero word).
    c.align(8)?;
    if c.pos != block.appendix.len()
        || lengths
            .iter()
            .try_fold(0usize, |a, n| a.checked_add(*n))
            .ok_or("Geometry lengths overflow")?
            != block.body.len()
    {
        return Err("Geometry record lengths do not cover body exactly".into());
    }
    let mut offset = 0;
    let mut result = Vec::new();
    for (index, length) in lengths.into_iter().enumerate() {
        let raw = checked_slice(&block.body, offset, length)?;
        let mut c = Cursor::new(raw);
        let id = c.u32()?;
        let class = c.u32()?;
        let nested = c.u32()?;
        let array_class = c.u32()?;
        if id != 100 || ![94, 95].contains(&class) || nested != 101 || array_class != 60 {
            return Err(format!(
                "Unsupported geometry record {index}; raw record retained"
            ));
        }
        let index_count = c.u32()? as usize;
        let scalar_count = c.u32()? as usize;
        if scalar_count > 3_000_000 || scalar_count % 3 != 0 {
            return Err("Invalid coordinate array size".into());
        }
        let values = c.take(
            scalar_count
                .checked_mul(4)
                .ok_or("Coordinate size overflow")?,
        )?;
        let mut positions = Vec::new();
        for point in values.chunks_exact(12) {
            let mut p = [0f32; 3];
            for i in 0..3 {
                p[i] = f32::from_le_bytes(point[4 * i..4 * i + 4].try_into().unwrap())
            }
            if p.iter().any(|x| !x.is_finite()) {
                return Err("Nonfinite geometry coordinate".into());
            }
            positions.push(p);
        }
        result.push(GeometryDefinition {
            index,
            record_offset: offset,
            record_bytes: length,
            serialized_class: class,
            index_count,
            positions,
            status: "vertices_only_indices_and_placement_unresolved",
        });
        offset += length;
    }
    Ok(result)
}
#[cfg(target_arch = "wasm32")]
mod web {
    use serde::Serialize;
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen(js_name=inspectNwdBytes)]
    pub fn inspect(
        bytes: &[u8],
        on_phase: &js_sys::Function,
    ) -> std::result::Result<JsValue, JsValue> {
        let phase = |text: &str| {
            let _ = on_phase.call1(&JsValue::NULL, &JsValue::from_str(text));
        };
        phase("Контейнер и распаковка потоков");
        let c = super::read_container(bytes).map_err(|e| JsValue::from_str(&e))?;
        phase("Координаты, индексы и полосы примитивов");
        let geometry = super::geometry::read_geometry(&c).map_err(|e| JsValue::from_str(&e))?;
        phase("Экземпляры, размещения и сверка геометрии");
        let fragments =
            super::fragments::read_fragments(&c, &geometry).map_err(|e| JsValue::from_str(&e))?;
        phase("Подготовка данных для сцены");
        serde_json::json!({"container":c,"geometry":geometry,"fragments":fragments,"units":{"status":"not_decoded","scale_to_m":null}}).serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e|JsValue::from_str(&e.to_string()))
    }
}
