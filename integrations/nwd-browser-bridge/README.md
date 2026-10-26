# Independent NWD reader

Experimental Rust crate with native CLI and `inspectNwdBytes` WASM export. The
same parser serves both. Does not require Navisworks, ODA, a model API or a server.

This is a validated subset of `lichunk-008 / navisworks:431`, not general NWD/NWC
support. It reads the container directory, bounded zlib members, geometry records,
compressed indices, strip lengths and a typed fragment graph. Unsupported layouts
remain explicit errors or partial results. Geometry counts and local bounds are
cross-checked. Source hashes, byte ranges and unknown fields are retained.

Units, full object hierarchy, BIM properties, extended materials, arbitrary matrix
placements, saved views, clash results and TimeLiner are not decoded. The browser
adapter requires an explicit unit assumption and stores it separately from source
observations. Geometric fragments are not labelled as physical equipment.

Positive public reference: Autodesk-Forge/models.autodesk.io `samples/GateHouse.nwd`.
Negative reference: `samples/Chair.nwd` uses additional geometry and material layouts
and must not be reported as a complete scene. Samples are not bundled; their
repository MIT license and provenance must be checked when obtaining them.

```powershell
cargo test --locked --manifest-path integrations/nwd-browser-bridge/Cargo.toml
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path integrations/nwd-browser-bridge/Cargo.toml
```

`tools/build_browser_runtime.py` builds bindings into the ignored browser runtime
directory. CLI: `cargo run --manifest-path integrations/nwd-browser-bridge/Cargo.toml -- input.nwd output-directory`.
Use separate output directories for different input files. No engineering facts
are accepted or saved to the project database by this low-level parser.
