//! Browser-only input/output boundary around the same converter as the CLI.
//! No filesystem or network I/O in this bridge; run inside a terminable worker.
use rvt::{RevitFile, walker::WalkerLimits};
use rvt::ifc::{ExportQualityMode, ExportResult, RvtDocExporter, saved_meshes, recount_exported, write_step};
use serde::Serialize;
mod document;
mod schedule_data;
pub use document::extract_document;

// Match the reader's technical limit rather than imposing the former demo cap.
pub const MAX_BROWSER_RVT_BYTES: usize = rvt::reader::DEFAULT_MAX_FILE_BYTES as usize;

fn validate_input_size(size: usize) -> Result<(), String> {
    if size == 0 || size > MAX_BROWSER_RVT_BYTES {
        return Err("RVT input must be non-empty and within the reader's 2 GiB limit; browser memory may be exhausted earlier".into());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct BrowserConversion {
    pub schema_version: u32,
    pub status: &'static str,
    pub export: ExportResult,
    pub saved_meshes: Option<saved_meshes::SavedMeshReport>,
    pub saved_mesh_error: Option<String>,
    pub quality_error: Option<String>,
    pub ifc_step: Option<String>,
}

pub fn convert_bytes(bytes: Vec<u8>) -> Result<BrowserConversion, String> {
    validate_input_size(bytes.len())?;
    let mut file = RevitFile::open_bytes(bytes).map_err(|e| e.to_string())?;
    let mode = ExportQualityMode::Geometry;
    let mut export = RvtDocExporter
        .export_with_diagnostics_mode_and_limits(&mut file, mode, WalkerLimits::default())
        .map_err(|e| e.to_string())?;
    // Match rvt-ifc --mode geometry --saved-meshes: enrich before the quality
    // gate; keep the original body and an explicit error when no mesh is read.
    let (saved_meshes, saved_mesh_error) = match saved_meshes::attach(&mut file, &mut export.model) {
        Ok(report) => {
            recount_exported(&mut export.diagnostics, &export.model);
            (Some(report), None)
        }
        Err(error) => (None, Some(error.to_string())),
    };
    let quality_error = mode.validate(&export.diagnostics).err().map(|e| e.to_string());
    let ifc_step = if quality_error.is_none() { Some(write_step(&export.model)) } else { None };
    Ok(BrowserConversion {
        schema_version: 1,
        status: if quality_error.is_none() { "converted_requires_review" } else { "unsupported_geometry" },
        export, saved_meshes, saved_mesh_error, quality_error, ifc_step,
    })
}

#[cfg(target_arch = "wasm32")]
mod web {
    use wasm_bindgen::prelude::*;
    use serde::Serialize;

    #[wasm_bindgen(js_name = extractRvtScheduleData)]
    pub fn extract_rvt_schedule_data(bytes: &[u8]) -> Result<JsValue, JsValue> {
        super::validate_input_size(bytes.len()).map_err(|e|JsValue::from_str(&e))?;
        let result=super::schedule_data::extract(bytes.to_vec()).map_err(|e|JsValue::from_str(&e))?;
        result.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|e|JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = extractRvtDocument)]
    pub fn extract_rvt_document(bytes: &[u8]) -> Result<JsValue, JsValue> {
        super::validate_input_size(bytes.len()).map_err(|e| JsValue::from_str(&e))?;
        let result = super::extract_document(bytes.to_vec()).map_err(|e| JsValue::from_str(&e))?;
        result.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = convertRvtBytes)]
    pub fn convert_rvt_bytes(bytes: &[u8]) -> Result<JsValue, JsValue> {
        // Guard before copying data across the JS/WASM boundary a second time.
        super::validate_input_size(bytes.len()).map_err(|e| JsValue::from_str(&e))?;
        let result = super::convert_bytes(bytes.to_vec()).map_err(|e| JsValue::from_str(&e))?;
        // Keep the large intermediate IFC entity graph inside WASM. Only the
        // STEP file and diagnostics cross the worker boundary. JSON-compatible
        // maps are ordinary JS objects, including provenance dictionaries.
        let payload = serde_json::json!({
            "schema_version": result.schema_version, "status": result.status,
            "diagnostics": result.export.diagnostics, "saved_meshes": result.saved_meshes,
            "saved_mesh_error": result.saved_mesh_error, "quality_error": result.quality_error,
            "ifc_step": result.ifc_step
        });
        use serde::Serialize;
        payload.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_non_cfb_input() {
        assert!(convert_bytes(vec![]).is_err());
        assert!(convert_bytes(b"Not an RVT container".to_vec()).is_err());
    }

    #[test]
    fn input_size_above_former_demo_limit_reaches_reader() {
        assert!(validate_input_size(65 * 1024 * 1024).is_ok());
        assert!(validate_input_size(512 * 1024 * 1024).is_ok());
        assert!(validate_input_size(MAX_BROWSER_RVT_BYTES + 1).is_err());
    }

    #[test]
    fn generic_field_reader_rejects_impossible_utf16_lengths_without_advancing() {
        use rvt::{formats::FieldType, walker::{read_field_by_type, InstanceField}};
        for count in [u32::MAX, 0x7ffffffe, 0x80000000, 100] {
            let input=count.to_le_bytes();let mut cursor=0;
            assert!(matches!(read_field_by_type(&input,&mut cursor,&FieldType::String),InstanceField::Bytes(_)));
            assert_eq!(cursor,0);
        }
        let mut cursor=0;
        let input=[2,0,0,0,0x10,0x04,0x11,0x04];
        assert!(matches!(read_field_by_type(&input,&mut cursor,&FieldType::String),InstanceField::String(s) if s=="АБ"));
        assert_eq!(cursor,input.len());
        let mut cursor=0;
        assert!(matches!(read_field_by_type(&[],&mut cursor,&FieldType::Primitive{kind:1,size:0}),InstanceField::Bytes(_)));
        assert_eq!(cursor,0);
    }
}
