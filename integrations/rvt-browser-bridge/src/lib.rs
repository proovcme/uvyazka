//! Browser-only input/output boundary around the same converter as the CLI.
//! No filesystem or network I/O in this bridge; run inside a terminable worker.
use rvt::{RevitFile, walker::WalkerLimits};
use rvt::ifc::{ExportQualityMode, ExportResult, RvtDocExporter, saved_meshes, recount_exported, write_step};
use serde::Serialize;

pub const MAX_BROWSER_RVT_BYTES: usize = 64 * 1024 * 1024;

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
    if bytes.is_empty() || bytes.len() > MAX_BROWSER_RVT_BYTES {
        return Err("Browser RVT input must be 1–64 MiB; larger models require local tools".into());
    }
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

    #[wasm_bindgen(js_name = convertRvtBytes)]
    pub fn convert_rvt_bytes(bytes: &[u8]) -> Result<JsValue, JsValue> {
        // Guard before copying data across the JS/WASM boundary a second time.
        if bytes.is_empty() || bytes.len() > super::MAX_BROWSER_RVT_BYTES {
            return Err(JsValue::from_str("Browser RVT input must be 1–64 MiB"));
        }
        let result = super::convert_bytes(bytes.to_vec()).map_err(|e| JsValue::from_str(&e))?;
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
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
}
