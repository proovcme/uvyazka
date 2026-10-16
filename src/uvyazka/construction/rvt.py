"""Local, isolated RVT reader adapter. Never starts Revit or uploads a model."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

from .importer import IMPORTER_VERSION, import_model, write_json
from .rvt_runtime import UPSTREAM_REVISION, binary_path, converter_status as runtime_status

ADAPTER_VERSION = "0.3.0"
RVT_MAX_BYTES = 512 * 1024 * 1024
IFC_MAX_BYTES = 100 * 1024 * 1024
OLE_SIGNATURE = bytes.fromhex("D0CF11E0A1B11AE1")


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def converter_path():
    return binary_path("rvt-ifc")


def converter_status():
    status = runtime_status()
    converter = status["binaries"]["rvt-ifc"]
    return {**status, "path": converter.get("path"), "adapter_version": ADAPTER_VERSION,
            "source_revision": converter.get("source_revision")}


def inspect_rvt(path):
    source = Path(path)
    validate_input(source, source.name)
    binary = binary_path("rvt-info")
    if not binary.is_file():
        raise ValueError("RVT-инспектор не установлен; запустите uv run python tools/setup_rvt.py")
    try:
        result = subprocess.run([str(binary), str(source.resolve()), "--json"], capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=60)
        if result.returncode:
            raise ValueError("Не удалось прочитать метаданные RVT: " + result.stderr[-1200:])
        return json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("Не удалось запустить RVT-инспектор: " + str(error)) from error


def validate_input(path, name):
    suffix = Path(name).suffix.lower()
    if suffix not in (".ifc", ".rvt"):
        raise ValueError("Поддерживаются файлы .ifc и .rvt")
    maximum = RVT_MAX_BYTES if suffix == ".rvt" else IFC_MAX_BYTES
    if not Path(path).is_file() or not 0 < Path(path).stat().st_size <= maximum:
        raise ValueError(f"Нужен непустой файл {suffix} до {maximum // 1024 // 1024} МБ")
    with Path(path).open("rb") as stream:
        header = stream.read(4096)
    if suffix == ".ifc" and not header.lstrip().startswith(b"ISO-10303-21;"):
        raise ValueError("Файл не является STEP IFC (ISO-10303-21)")
    if suffix == ".rvt" and not header.startswith(OLE_SIGNATURE):
        raise ValueError("Файл не является RVT-контейнером OLE/CFB")
    return suffix


def import_identity(path, name):
    digest = file_hash(path)
    if Path(name).suffix.lower() != ".rvt":
        return digest
    binary = converter_path()
    if not binary.is_file():
        raise ValueError("Конвертер RVT не установлен. Запустите uv run python tools/setup_rvt.py и повторите загрузку.")
    # Separate models produced by different converter builds and quantity policies.
    return hashlib.sha256(f"{digest}:{file_hash(binary)}:{ADAPTER_VERSION}:{IMPORTER_VERSION}".encode()).hexdigest()


def normalize_rvt_ifc(path):
    """Repair exporter schema bookkeeping, without changing bodies or product IDs."""
    import ifcopenshell
    model = ifcopenshell.open(str(path))
    changes = []
    for history in model.by_type('IfcOwnerHistory'):
        if history.LastModifiedDate is None and history.ChangeAction in ('ADDED', 'MODIFIED', 'DELETED'):
            # This describes the newly generated IFC artifact, not RVT edit history.
            history.LastModifiedDate = history.CreationDate
            changes.append({'rule': 'ifc_owner_history_change_date', 'step_id': history.id(),
                'value': history.CreationDate, 'basis': 'IFC artifact creation timestamp'})
    for relation in list(model.by_type('IfcRelContainedInSpatialStructure')):
        spatial = [item for item in relation.RelatedElements if item.is_a('IfcSpatialStructureElement')]
        if not spatial:
            continue
        parent = relation.RelatingStructure
        pending = []
        for child in spatial:
            if any(item.RelatingObject != parent for item in child.Decomposes):
                raise ValueError('Противоречивые пространственные родители в RVT-экспорте; автоматическое исправление остановлено')
            if not child.Decomposes:
                pending.append(child)
        if pending:
            key = 'ifccs-rvt-spatial:' + parent.GlobalId + ':' + ':'.join(sorted(child.GlobalId for child in pending))
            model.create_entity('IfcRelAggregates', GlobalId=ifcopenshell.guid.compress(uuid.uuid5(uuid.NAMESPACE_URL, key).hex),
                OwnerHistory=relation.OwnerHistory, RelatingObject=parent, RelatedObjects=pending)
        changes.append({'rule': 'spatial_aggregation_instead_of_element_containment',
            'parent_global_id': parent.GlobalId, 'child_global_ids': [child.GlobalId for child in spatial]})
        remaining = [item for item in relation.RelatedElements if item not in spatial]
        if remaining:
            relation.RelatedElements = remaining
        else:
            model.remove(relation)
    if changes:
        model.write(str(path))
    return changes


def import_source(source_path, output_path, source_name=None):
    source, output = Path(source_path), Path(output_path)
    name = source_name or source.name
    suffix = validate_input(source, name)
    if suffix == ".ifc":
        return import_model(str(source), str(output), name)
    identity = import_identity(source, name)
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "progress.json", {"status": "running", "message": "RVT → IFC · чтение элементов и сохранённых сеток", "processed": 0, "total": 0})
    binary = converter_path()
    metadata = inspect_rvt(source)
    write_json(output / "rvt-metadata.json", metadata)
    version = metadata.get("version") or metadata.get("document", {}).get("revit_version")
    # Only an explicit, known-old release can be rejected before conversion.
    if version and str(version).isdigit() and int(version) < 2023:
        raise ValueError(f"RVT Revit {version}: rvt-rs читает метаданные, но геометрия этой версии пока не поддерживается. Нативное извлечение данных доступно отдельно; для геометрии можно передать готовый IFC.")
    converted = output / "converted.ifc"
    diagnostics_path = output / "conversion-diagnostics.json"
    command = [str(binary), str(source.resolve()), "-o", str(converted.resolve()),
               "--mode", "geometry", "--saved-meshes", "--diagnostics", str(diagnostics_path.resolve())]
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Чтение геометрии RVT превысило 15 минут. Исходный файл сохранён; параметры, виды и спецификации можно извлекать отдельным нативным этапом.") from error
    except OSError as error:
        raise ValueError(f"Не удалось запустить локальный конвертер RVT: {error}") from error
    (output / "conversion.log").write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
    if result.returncode or not converted.is_file() or not diagnostics_path.is_file():
        detail = (result.stderr or result.stdout)[-1800:]
        raise ValueError(f"rvt-rs не смог получить геометрию этой RVT-модели. Пустой IFC не принят. {detail}")
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    if diagnostics.get("schema_version") != 1:
        raise ValueError("Неподдерживаемая схема диагностики RVT; импорт остановлен")
    raw_path = output / 'raw-converted.ifc'
    import shutil
    shutil.copyfile(converted, raw_path)
    repairs = normalize_rvt_ifc(converted)
    write_json(output / 'conversion-repairs.json', repairs)
    import ifcopenshell
    import ifcopenshell.validate
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(ifcopenshell.open(str(converted)), logger, express_rules=True)
    checks = [{'level': item.get('level'), 'attribute': item.get('attribute'),
        'message': item.get('message'), 'instance': str(item.get('instance'))} for item in logger.statements]
    write_json(output / 'ifc-validation.json', checks)
    if any(item['level'] == 'error' for item in checks):
        raise ValueError('IFC после RVT-конверсии не прошёл проверку схемы. Диагностика сохранена; модель не опубликована.')
    package = output / "ifc-package"
    imported = import_model(str(converted), str(package), name, complete_progress=False)
    manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
    converted_source = dict(manifest["source"])
    conversion = {"engine": "rvt-rs", "adapter_version": ADAPTER_VERSION,
        "source_revision": converter_status()["source_revision"], "binary_sha256": file_hash(binary),
        "ifc_sha256": converted_source["sha256"], "ifc_size_bytes": converted_source["size_bytes"],
        "raw_ifc_sha256": file_hash(raw_path), "normalization": repairs, "ifc_validation_errors": 0,
        "input": diagnostics.get("input"), "revit_version": version, "exported": diagnostics.get("exported"),
        "confidence": diagnostics.get("confidence"), "source_coverage": diagnostics.get("source_coverage"),
        "warnings": diagnostics.get("warnings", []), "unsupported_features": diagnostics.get("unsupported_features", []),
        "skipped": diagnostics.get("skipped", []), "diagnostics_file": "conversion-diagnostics.json",
        "quantity_policy": "Only decoded non-box bodies supply geometric work quantities; missing/box/unknown bodies use explicit piece assumptions. No Revit fidelity guarantee."}
    manifest["model_id"] = identity
    manifest["source"].update({"filename": name, "format": "rvt", "sha256": file_hash(source),
        "size_bytes": source.stat().st_size, "conversion": conversion})
    for row in manifest["elements"]:
        row["source"]["original_file_sha256"] = manifest["source"]["sha256"]
        row["source"]["conversion_engine"] = "rvt-rs"
    from .revit_metadata import read_revit_metadata
    manifest['revit'] = read_revit_metadata(source, output, manifest)
    manifest["diagnostics"].append({"element_id": "model", "kind": "conversion",
        "message": "Экспериментальная конверсия RVT → IFC. Неполнота и упрощения перечислены в диагностике; габаритные блоки не используются как объёмы работ."})
    (package / "geometry.bin").replace(output / "geometry.bin")
    # Publish the manifest last: an interrupted conversion is never a cached model.
    write_json(output / "manifest.json", manifest)
    write_json(output / "progress.json", {"status": "completed", "processed": len(manifest["elements"]),
        "total": len(manifest["elements"]), "message": "RVT-модель готова · проверьте ограничения конверсии"})
    return {**imported, "model_id": identity, "conversion": conversion}
