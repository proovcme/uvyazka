"""Locate local RVT tools without importing NumPy, IfcOpenShell or an SDK."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re


UPSTREAM_REVISION = "120e2f9ffa8422ba437102c8d300b7e902cdde80"
NAMES = ("rvt-ifc", "rvt-info", "rvt-capabilities", "ifccs-rvt-metadata")
ENV = {"rvt-ifc": "UVYAZKA_RVT_IFC", "rvt-info": "UVYAZKA_RVT_INFO",
       "rvt-capabilities": "UVYAZKA_RVT_CAPABILITIES", "ifccs-rvt-metadata": "UVYAZKA_RVT_METADATA"}


def binary_name(name):
    return name + (".exe" if os.name == "nt" else "")


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _locate(name, home=None):
    from ..core import default_home
    override = os.environ.get(ENV[name])
    legacy = os.environ.get("IFCCS_RVT_IFC")
    converter_override = os.environ.get("UVYAZKA_RVT_IFC") or legacy
    if name == "rvt-ifc": override = override or legacy
    if override:
        return Path(override).expanduser().resolve(), "override", None
    if os.environ.get("UVYAZKA_RVT_BIN_DIR"):
        return Path(os.environ["UVYAZKA_RVT_BIN_DIR"]).expanduser().resolve()/binary_name(name), "override", None
    if converter_override:
        return Path(converter_override).expanduser().resolve().with_name(binary_name(name)), "override", None
    runtime = Path(home or default_home())/"tools/rvt"
    active = runtime/"active.json"
    if active.is_file():
        data = json.loads(active.read_text(encoding='utf-8'))
        release = data.get("release", "")
        if data.get("schema_version") != 1 or not re.fullmatch(r"[0-9a-f]{64}", release):
            raise ValueError("Invalid local RVT runtime manifest; rerun tools/setup_rvt.py")
        folder = runtime/"releases"/release
        manifest = json.loads((folder/"manifest.json").read_text(encoding='utf-8'))
        if manifest.get("schema_version") != 1 or manifest.get("release") != release:
            raise ValueError("RVT runtime manifests disagree; rerun tools/setup_rvt.py")
        return folder/binary_name(name), "managed", manifest
    root = Path(__file__).resolve().parents[3]/"integrations"
    crate = 'rvt-metadata-reader' if name == 'ifccs-rvt-metadata' else 'rvt-rs'
    return root/crate/'target/release'/binary_name(name), "checkout", None


def binary_path(name, home=None):
    path, origin, manifest = _locate(name, home)
    if origin == 'managed' and (not path.is_file() or manifest.get('binaries', {}).get(name) != sha256(path)):
        raise ValueError("Local RVT binary is missing or changed; rerun tools/setup_rvt.py")
    return path


def converter_status(home=None):
    rows = {}
    for name in NAMES:
        try:
            path, origin, manifest = _locate(name, home)
            exists = path.is_file()
            valid = exists and (origin != 'managed' or manifest.get('binaries', {}).get(name) == sha256(path))
            rows[name] = {"path": str(path), "available": valid, "origin": origin,
                "integrity": "verified" if origin == 'managed' and valid else "unverified" if valid else "missing_or_changed",
                "source_revision": manifest.get('upstream_revision') if origin == 'managed' and valid else None,
                "local_patches":manifest.get('local_patches',[]) if origin == 'managed' and valid else []}
        except (OSError, ValueError, KeyError) as error:
            rows[name] = {"available": False, "error": str(error)}
    return {"engine": "rvt-rs", "available": all(rows[k]['available'] for k in ('rvt-ifc','rvt-info')),
        "phase_reader_available": rows['ifccs-rvt-metadata']['available'], "binaries": rows,
        "local_only": True, "max_bytes": 512*1024*1024,
        "setup": "uv run python tools/setup_rvt.py (source checkout, Rust and native build tools required)",
        "limitations": "Partial RVT/version/category support. Geometry and quantities require review; bounding boxes cannot supply work volumes."}
