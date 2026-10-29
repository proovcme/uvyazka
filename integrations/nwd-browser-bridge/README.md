# Independent NWD reader

Experimental Rust crate with a native CLI and `inspectNwdBytes` WASM export.
Both use the same parser. No Navisworks, ODA, model API or server is required.

Recognized container: `lichunk-008`; observed serialization schemes: 431, 441,
448. These are serialization identifiers, not a promise to read every file from
any particular Navisworks release. Unknown layouts fail explicitly or retain a
partial report. This is not general NWD/NWC/NWF support.

The reader decodes bounded zlib members, compressed coordinates and topology,
triangle strips, fragment placements, the source logical hierarchy and paged
attribute graphs. IDs remain scoped to the model namespace, stream and property
page. Typed properties, exact integer strings, source GUIDs, byte addresses and
unresolved slots remain inspectable. Observed Revit IDs are not confused with
NWD GUIDs or IFC GlobalIds. Source unit headers are read when supported; the
browser requests a recorded assumption for unknown headers.

Geometry indices, primitive counts and local bounds are cross-checked. The
coordinate-index reader accepts bounded repeat runs `0x80..0xdf`, with synthetic
tests for the long-run topology and overflow. The WASM report includes
`reader_revision`; the browser checks it before accepting the result and versions
derived model IDs. [Mixed-scene validation](../../docs/MIXED_SCENE_VALIDATION.md).
The browser keeps source nodes separate from geometric fragments, preserves property
provenance and never counts fragments as physical equipment. Rigid translation, quaternion and observed uniform-scale/reflection placements
are supported. Reused bounds objects retain their geometry reference. Embedded
material resources are bounded and hashed without loading external assets.
Browser geometry crosses WASM as packed binary; the native CLI retains arrays. Source assets
are data only: no remote resources, JSON code or schema XML is executed.

Not yet imported: saved views, selection sets, clash results and TimeLiner.
Textures/shaders, arbitrary affine transforms, all primitive types and all
serialization variants remain unsupported. `complete_file_support` stays false;
per-model geometry and property coverage must be inspected separately.

Public references: Autodesk-Forge/models.autodesk.io `samples/GateHouse.nwd` and
`samples/Chair.nwd`. Samples are not bundled. Check repository MIT licensing and
source provenance when obtaining them. Private source models and their derived
reports must remain outside version control.

```powershell
cargo test --locked --manifest-path integrations/nwd-browser-bridge/Cargo.toml
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path integrations/nwd-browser-bridge/Cargo.toml
cargo run --manifest-path integrations/nwd-browser-bridge/Cargo.toml -- input.nwd output-directory --scene
```

`--scene` writes `scene.json` with the same per-source report as WASM. The default
CLI mode writes legacy geometry diagnostics and extracted stream bodies;
`--metadata-only` skips geometry decoding. Use a separate private output directory
for each source. `tools/build_browser_runtime.py` builds the WASM bindings into
an ignored runtime directory. The parser does not accept engineering facts or
write to the project database.


Recovery is bounded by proven record boundaries. Geometry-directory slots remain
stable when a single record is unsupported or corrupt. Fully consumed fragment
records retain semantic errors without desynchronizing following graph objects;
unknown graph layouts still stop the current sequential stream. Fixed-size
invalid appearance channels and bounded malformed saved JSON do not invalidate
independently decoded geometry. Nullable placements/references are unavailable,
never identity transforms or references to slot zero. Property-slot mismatches
preserve the tree but disable unverified external property attribution.
The browser retains healthy fragments and marks per-source coverage; partial
support is never reported as complete Navisworks compatibility.
See [recovery policy and synthetic file generator](../../docs/NWD.md).
