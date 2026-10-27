use std::{env, fs, path::Path};
use uvyazka_nwd_experiment::{fragments::read_fragments, geometry::read_geometry, read_container};
fn main() {
    if let Err(error) = run() {
        eprintln!("NWD: {error}");
        std::process::exit(1)
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 3
        && !(args.len() == 4 && matches!(args[3].as_str(), "--metadata-only" | "--scene"))
    {
        return Err(
            "Usage: uvyazka-nwd-experiment input.nwd output-directory [--metadata-only|--scene]"
                .into(),
        );
    }
    let path = Path::new(&args[1]);
    if fs::metadata(path)?.len() > uvyazka_nwd_experiment::MAX_INPUT as u64 {
        return Err("Input budget exceeded".into());
    }
    let data = fs::read(path)?;
    let result = read_container(&data)?;
    let output = Path::new(&args[2]);
    fs::create_dir_all(output)?;
    if args.get(3).is_some_and(|mode| mode == "--scene") {
        let scene = uvyazka_nwd_experiment::scene::read_scene(&result);
        serde_json::to_writer(
            std::io::BufWriter::new(fs::File::create(output.join("scene.json"))?),
            &uvyazka_nwd_experiment::scene::SceneReport {
                container: &result,
                scene,
            },
        )?;
        println!("Scene report saved; inspect per-model coverage and diagnostics.");
        return Ok(());
    }
    fs::write(
        output.join("container.json"),
        serde_json::to_vec_pretty(&result)?,
    )?;
    for (i, block) in result.blocks.iter().enumerate() {
        if !block.body.is_empty() {
            fs::write(output.join(format!("block-{i:03}.bin")), &block.body)?;
        }
        if !block.appendix.is_empty() {
            fs::write(
                output.join(format!("block-{i:03}-index.bin")),
                &block.appendix,
            )?;
        }
    }
    let logical_models = uvyazka_nwd_experiment::metadata::read_logical_models(&result);
    fs::write(
        output.join("logical-models.json"),
        serde_json::to_vec(&logical_models)?,
    )?;
    if args.len() == 4 {
        return Ok(());
    }
    let geometry = read_geometry(&result)?;
    let fragments = read_fragments(&result, &geometry)?;
    let partial = fragments.decoded != fragments.declared
        || fragments.diagnostic.is_some()
        || fragments
            .rows
            .iter()
            .any(|f| !f.local_bounds_match || !f.primitive_count_matches)
        || geometry.iter().any(|g| g.diagnostic.is_some());
    fs::write(
        output.join("model.json"),
        serde_json::to_vec(
            &serde_json::json!({"container":result,"geometry":geometry,"fragments":fragments,"units":{"status":"not_decoded","scale_to_m":null}}),
        )?,
    )?;
    fs::write(
        output.join("geometry-definitions.json"),
        serde_json::to_vec(&geometry)?,
    )?;
    println!(
        "{}",
        serde_json::json!({"status":if fragments.decoded==0 {"unsupported_scene"} else if partial {"partial_geometry"} else {"geometry_preview_requires_review"},"diagnostic":fragments.diagnostic,"source_sha256":result.source_sha256,"blocks":result.blocks.len(),"geometry_definitions":geometry.len(),"geometry_definitions_decoded":geometry.iter().filter(|g|g.diagnostic.is_none()).count(),"triangles":geometry.iter().map(|g|g.triangles.len()).sum::<usize>(),"fragments_decoded":fragments.decoded,"fragments_declared":fragments.declared,"fragment_questions":fragments.rows.iter().filter(|f|f.status!="decoded_requires_review").count(),"source_units":"not_decoded","geometry_placement":"explicit_translation_subset_requires_review"})
    );
    if fragments.decoded == 0 {
        return Err(format!(
            "No supported scene instances: {}. Container and partial report saved.",
            fragments
                .diagnostic
                .as_deref()
                .unwrap_or("empty fragment array")
        )
        .into());
    }
    Ok(())
}
