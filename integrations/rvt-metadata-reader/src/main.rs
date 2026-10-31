//! Read bounded native records through the pinned decoder, without editing RVT.
use rvt::{RevitFile};
use rvt::research::{native_document};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs};
mod extract;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 5 && args[1] == "--extract" {
        return extract::run(&args[2], &args[3], &args[4]);
    }
    if args.len() != 4 { return Err("usage: ifccs-rvt-metadata INPUT.rvt IDS.json OUTPUT.json".into()); }
    let ids: Vec<u64> = serde_json::from_str(&fs::read_to_string(&args[2])?)?;
    let mut file = RevitFile::open(&args[1])?;
    let options = native_document::Options {
        selected_ids: ids.into_iter().collect(),
        selected_classes: BTreeSet::from(["ProjectPhase".into(), "AllProjectPhases".into(),
            "RevitLinkInstance".into(), "ProjectLocation".into()]),
        ..Default::default()
    };
    let mut records: Vec<Value> = Vec::new();
    let summary = native_document::extract(&mut file, &options, |record| {
        let root = record.graph.as_ref().and_then(|g| g.objects.first());
        records.push(json!({"identity": record.identity, "class_name": record.class_name,
            "status": record.status, "diagnostic": record.diagnostic,
            "source": record.source, "root_fields": root.map(|r| &r.fields),
            "saved_metadata": record.saved_metadata,
            "metadata_diagnostic": record.metadata_diagnostic}));
        Ok(())
    })?;
    fs::write(&args[3], serde_json::to_vec(&json!({"schema_version":1,
        "value_semantics":"serialized_not_evaluated", "records":records,"summary":summary}))?)?;
    Ok(())
}
