# Browser runtime provenance

Generated binaries live in ignored `.uvyazka-build/browser-runtime` and are rebuilt with
`tools/build_browser_runtime.py`. All runtime requests are same-origin.

| Component | Pinned source | License |
|---|---|---|
| web-ifc | npm `web-ifc@0.0.78`, integrity in web/package-lock.json; [source](https://github.com/ThatOpen/engine_web-ifc/tree/v0.0.78) | MPL-2.0, distributed LICENSE.md |
| Pyodide | npm `pyodide@314.0.7`, integrity in web/package-lock.json; [source](https://github.com/pyodide/pyodide/tree/314.0.7) | MPL-2.0, PYODIDE-LICENSE.txt |
| Python stdlib | Included in the pinned Pyodide distribution; [CPython](https://github.com/python/cpython/tree/v3.14.2) | PSF and included notices, PYTHON-LICENSE.txt |
| RVT WASM | `../rvt-browser-bridge`, `../rvt-rs/UVYAZKA-SOURCE.json` | Apache-2.0 + original NOTICE |
| Planner | Selected unmodified Python modules in src/uvyazka/construction | Project terms; see docs/DEPENDENCIES.md |

The schema hierarchy JSON is generated from IfcOpenShell's IFC2X3, IFC4 and
IFC4X3_ADD2 declarations. No user model or project database is included.
`release.json` lists the SHA-256 of every published runtime asset.
The source distribution includes the bridge, adapters, workers, planner,
build scripts and dependency lockfiles; third-party runtime sources remain
available at the pinned upstream links above.
