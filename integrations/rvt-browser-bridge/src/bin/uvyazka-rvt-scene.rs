#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{env, fs::File, io::BufWriter, path::PathBuf};

    let args: Vec<_> = env::args_os().skip(1).map(PathBuf::from).collect();
    let [source, manifest, geometry] = args.as_slice() else {
        return Err("Usage: uvyazka-rvt-scene SOURCE.rvt SCENE.json GEOMETRY.bin".into());
    };
    let result = uvyazka_rvt_browser::extract_direct_path(source)?;
    serde_json::to_writer(BufWriter::new(File::create(manifest)?), &result.manifest)?;
    std::fs::write(geometry, result.geometry_binary)?;
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn main() {}
