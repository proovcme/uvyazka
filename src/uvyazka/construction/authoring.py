"""Local revisioned drawing projects shared by any MCP client, independent of chat providers."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import uuid

from .drawings import SUPPORTED, MAX_BYTES, source_info, inspect_source, render_source
from .ifc_authoring import COMPILER_VERSION, compile_ifc
from .importer import import_model, write_json
from .model_spec import ModelSpec
from .planner import build_scenario
from .simulation import SimulationEngine
from .rvt import RVT_MAX_BYTES, import_identity, import_source, validate_input


class DrawingProjects:
    def __init__(self, cache: Path, read_roots=(), viewer_url="http://127.0.0.1:8765", readonly=False):
        self.cache = cache.resolve()
        self.root = self.cache / "authoring"
        self.readonly=readonly
        if readonly and not (self.root/"projects.sqlite3").is_file():
            raise ValueError("Drawing workspace not found; create it first")
        if not readonly: self.root.mkdir(parents=True, exist_ok=True)
        self.read_roots = [Path(path).resolve() for path in read_roots]
        self.viewer_url = viewer_url.rstrip("/")
        if not readonly:
            with self.connect() as db:
                db.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)")

    def connect(self):
        if self.readonly: return sqlite3.connect((self.root/"projects.sqlite3").as_uri()+"?mode=ro",uri=True,timeout=30)
        return sqlite3.connect(self.root / "projects.sqlite3", timeout=30)

    def _id(self, project_id):
        if not re.fullmatch(r"[a-f0-9]{32}", project_id):
            raise ValueError("Некорректный идентификатор проекта")
        return project_id

    def get(self, project_id):
        self._id(project_id)
        with self.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            raise ValueError("Проект не найден")
        return json.loads(row[0])

    def _commit(self, project_id, expected_revision, data):
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("Нужна целая ожидаемая ревизия")
        updated = {**data, "revision": expected_revision + 1}
        with self.connect() as db:
            changed = db.execute("UPDATE projects SET revision=?, data=? WHERE id=? AND revision=?",
                (updated["revision"], json.dumps(updated, ensure_ascii=False, allow_nan=False), project_id, expected_revision)).rowcount
            if changed != 1:
                raise ValueError("Конфликт ревизии: перечитайте проект; чужие изменения не перезаписаны")
        return updated

    def create(self, name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 256:
            raise ValueError("Нужно название проекта длиной до 256 символов")
        key = uuid.uuid4().hex
        data = {"id": key, "name": name, "revision": 0, "sources": {}, "spec": None, "builds": [], "active_build_id": None}
        with self.connect() as db:
            db.execute("INSERT INTO projects VALUES (?, 0, ?)", (key, json.dumps(data, ensure_ascii=False)))
        return self.summary(data)

    def summary(self, project):
        active = next((build for build in project["builds"] if build["id"] == project["active_build_id"]), None)
        return {key: project[key] for key in ("id", "name", "revision", "sources")} | {
            "has_spec": project["spec"] is not None, "element_count": len(project["spec"]["elements"]) if project["spec"] else 0,
            "active_build": active, "build_count": len(project["builds"]),
            "build_stale": bool(active and active["spec_sha256"] != self.spec_hash(project["spec"]))}

    @staticmethod
    def spec_hash(spec):
        return hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()

    def register_source(self, project_id, expected_revision, filename, *, path=None, content_base64=None):
        project = self.get(project_id)
        if (path is None) == (content_base64 is None):
            raise ValueError("Передайте ровно один источник: path или content_base64")
        filename = Path(filename.replace("\\", "/")).name
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED:
            raise ValueError("Поддержаны PDF, DXF, PNG/JPEG/WebP; DWG требует CAD-адаптера")
        if path is not None:
            candidate = Path(path).resolve()
            if not any(candidate.is_relative_to(root) for root in self.read_roots):
                raise ValueError("Файл вне разрешённых корней чтения; передайте байты или настройте read-root")
            if not candidate.is_file() or not 0 < candidate.stat().st_size <= MAX_BYTES:
                raise ValueError("Источник должен быть файлом размером до 50 МБ")
            content = candidate.read_bytes()
        else:
            if not isinstance(content_base64, str) or len(content_base64) > MAX_BYTES * 4 // 3 + 8:
                raise ValueError("Источник превышает 50 МБ")
            content = base64.b64decode(content_base64, validate=True)
        if not 0 < len(content) <= MAX_BYTES:
            raise ValueError("Источник должен содержать от 1 байта до 50 МБ")
        digest = hashlib.sha256(content).hexdigest()
        key = digest + suffix
        directory = self.root / project_id / "sources"; directory.mkdir(parents=True, exist_ok=True)
        target = directory / key
        if not target.exists():
            temporary = directory / (uuid.uuid4().hex + suffix)
            temporary.write_bytes(content)
            try:
                info = source_info(temporary)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            info = source_info(target)
        project["sources"][key] = {"id": key, "filename": filename, "sha256": digest, "bytes": len(content), **info}
        updated = self._commit(project_id, expected_revision, project)
        return {"project_id": project_id, "revision": updated["revision"], "source": updated["sources"][key]}

    def source_path(self, project_id, source_id):
        project = self.get(project_id)
        if source_id not in project["sources"]:
            raise ValueError("Источник не принадлежит проекту")
        path = self.root / project_id / "sources" / source_id
        if hashlib.sha256(path.read_bytes()).hexdigest() != project["sources"][source_id]["sha256"]:
            raise ValueError("Контрольная сумма исходника не совпадает")
        return path

    def inspect(self, project_id, source_id, page=1, offset=0, limit=200):
        return {"source_id": source_id, **inspect_source(self.source_path(project_id, source_id), page, offset, limit)}

    def render(self, project_id, source_id, page=1, region=None):
        return render_source(self.source_path(project_id, source_id), page, region)

    def _check_evidence(self, project, spec):
        for frame in spec.drawing_frames:
            source = project['sources'].get(frame.source_id)
            if not source or not 1 <= frame.page <= source['pages']:
                raise ValueError('Калибровка ссылается на неизвестный исходник/лист')
        for record in [*spec.storeys, *spec.elements]:
            for evidence in record.evidence:
                source = project["sources"].get(evidence.source_id)
                if not source or not 1 <= evidence.page <= source["pages"]:
                    raise ValueError(f"Неизвестный источник или лист у {record.id}")
                if source["format"] == "dwg":
                    raise ValueError("Сначала зарегистрируйте читаемый экспорт DWG; исходник не разобран")
            if hasattr(record, "assumptions") and any(e.basis == "assumed" for e in record.evidence) and not record.assumptions:
                raise ValueError(f"Для предположения {record.id} заполните assumptions")

    def set_spec(self, project_id, expected_revision, spec):
        project = self.get(project_id)
        spec = ModelSpec.model_validate(spec)
        self._check_evidence(project, spec)
        project["spec"] = spec.model_dump(mode="json")
        return self.summary(self._commit(project_id, expected_revision, project))

    def update_elements(self, project_id, expected_revision, upsert, remove_ids=()):
        project = self.get(project_id)
        if not project["spec"]:
            raise ValueError("Сначала задайте полный ModelSpec с уровнями и материалами")
        rows = {row["id"]: row for row in project["spec"]["elements"]}
        for key in remove_ids:
            if key not in rows:
                raise ValueError("Удаляемый элемент не найден")
            del rows[key]
        if len({row['id'] for row in upsert}) != len(upsert):
            raise ValueError("Повторение идентификаторов в одном пакете")
        for row in upsert:
            rows[row["id"]] = row
        project["spec"]["elements"] = list(rows.values())
        return self.set_spec(project_id, expected_revision, project["spec"])

    def build(self, project_id, expected_revision):
        project = self.get(project_id)
        if project['revision'] != expected_revision:
            raise ValueError("Конфликт ревизии: перечитайте проект")
        spec = ModelSpec.model_validate(project["spec"])
        self._check_evidence(project, spec)
        for key in project["sources"]:
            self.source_path(project_id, key)
        build_id = uuid.uuid4().hex
        directory = self.root / project_id / "builds" / build_id
        directory.mkdir(parents=True)
        output = directory / "model.ifc"
        result = compile_ifc(spec, project_id, output, project["sources"])
        # Import to a private stage; publish only complete, validated packages.
        imported = directory / "package"
        import_model(str(output), str(imported), source_name=spec.name + ".ifc")
        manifest = json.loads((imported / "manifest.json").read_text(encoding="utf-8"))
        expected_ids = {str(row['step_id']) for row in result['element_map'].values()}
        generated = [e for e in manifest['elements'] if e['id'] in expected_ids]
        failures = [e['id'] for e in generated if e['mesh'] is None]
        if len(generated) != len(expected_ids):
            raise ValueError('Потеряны заданные IFC-элементы при импорте')
        if failures:
            raise ValueError("Не получена геометрия IFC-элементов: " + ", ".join(failures))
        if len(result["element_map"]) != len(spec.elements):
            raise ValueError("Потеряны элементы при генерации")
        digest = manifest["model_id"]
        build = {"id": build_id, "model_id": digest, "spec_sha256": self.spec_hash(project["spec"]), "spec_revision": expected_revision,
            "ifc_path": str(output), "viewer_url": self.viewer_url + "/?model=" + digest, "validation": result,
            "statistics": manifest["statistics"], "source_ids": list(project["sources"]), "assumptions": spec.assumptions}
        write_json(directory / "validation.json", build)
        project["builds"].append(build); project["active_build_id"] = build_id
        # Publish the immutable package first; only then change the active build
        # with CAS. Conflicting agents leave reviewable artifacts, not bad pointers.
        target = self.cache / "models" / digest
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            imported.rename(target)
        else:
            # Source hashes include GUIDs/timestamps, so collisions mean the same
            # bytes. Still check integrity instead of trusting a directory name.
            existing = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
            if existing["model_id"] != digest or not (target / "geometry.bin").is_file():
                raise ValueError("Повреждён ранее опубликованный пакет")
        updated = self._commit(project_id, expected_revision, project)
        return {"project_id": project_id, "revision": updated["revision"], "build": build}

    def active_build(self, project_id):
        project = self.get(project_id)
        build = next((b for b in project["builds"] if b["id"] == project["active_build_id"]), None)
        if not build or build["spec_sha256"] != self.spec_hash(project["spec"]):
            raise ValueError("Нет актуальной сборки: после изменений вызовите build_ifc")
        return build

    def simulate(self, project_id, variant="base", seed=42, concrete_curing_days=28, production=None):
        build = self.active_build(project_id)
        return self.simulate_model(build['model_id'], variant, seed, concrete_curing_days, production)

    def model(self, model_id):
        if not re.fullmatch(r'[a-f0-9]{64}', model_id):
            raise ValueError('Неверный идентификатор модели')
        directory = self.cache / 'models' / model_id
        if not (directory / 'manifest.json').is_file():
            raise ValueError('Модель не найдена')
        return json.loads((directory / 'manifest.json').read_text(encoding='utf-8')), directory

    def import_ifc(self, filename, path=None, content_base64=None):
        if (path is None) == (content_base64 is None) or Path(filename).suffix.lower() != '.ifc':
            raise ValueError('Передайте IFC через path или content_base64')
        if path is not None:
            candidate = Path(path).resolve()
            if not any(candidate.is_relative_to(root) for root in self.read_roots):
                raise ValueError('IFC вне разрешённых корней чтения')
            if not candidate.is_file() or not 0 < candidate.stat().st_size <= MAX_BYTES:
                raise ValueError('IFC должен быть файлом до 50 МБ')
            content = candidate.read_bytes()
        else:
            if not isinstance(content_base64, str) or len(content_base64) > MAX_BYTES * 4 // 3 + 8:
                raise ValueError('IFC превышает 50 МБ')
            content = base64.b64decode(content_base64, validate=True)
        if not 0 < len(content) <= MAX_BYTES or not content[:4096].lstrip().startswith(b'ISO-10303-21;'):
            raise ValueError('Нужен STEP IFC размером до 50 МБ')
        digest = hashlib.sha256(content).hexdigest()
        staging = self.root / 'imports' / uuid.uuid4().hex
        staging.mkdir(parents=True)
        source = staging / 'source.ifc'; source.write_bytes(content)
        imported = staging / 'package'
        import_model(str(source), str(imported), Path(filename.replace('\\', '/')).name)
        target = self.cache / 'models' / digest; target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            imported.rename(target)
        model, _ = self.model(digest)
        return {'model_id': digest, 'statistics': model['statistics'], 'source': model['source'],
            'viewer_url': self.viewer_url + '/?model=' + digest}

    def simulate_model(self, model_id, variant="base", seed=42, concrete_curing_days=28, production=None, phase_selections=None):
        if type(seed) is not int or not 0 <= seed <= 2147483647:
            raise ValueError("Некорректный seed")
        model, _ = self.model(model_id)
        run = SimulationEngine(build_scenario(model, variant=variant, seed=seed,
            concrete_curing_days=concrete_curing_days, production=production, phase_selections=phase_selections)).run()
        directory = self.cache / "runs"; directory.mkdir(exist_ok=True)
        write_json(directory / (run["run_id"] + ".json"), run)
        return {"model_id": model_id, "run_id": run["run_id"], "status": run["status"], "duration_minutes": run["duration"],
            "operations": len(run["scenario"]["operations"]), "unplanned_elements": len(run["scenario"]["unplanned_element_ids"]),
            "assumptions": run["scenario"]["assumptions"], "viewer_url": self.viewer_url + '/?model=' + model_id,
            "run_url": self.viewer_url + "/api/runs/" + run["run_id"]}

    def import_rvt(self, filename, path=None, content_base64=None):
        if (path is None) == (content_base64 is None) or Path(filename).suffix.lower() != '.rvt':
            raise ValueError('Передайте RVT через path или content_base64')
        staging = self.root / 'imports' / uuid.uuid4().hex
        staging.mkdir(parents=True)
        source = staging / 'source.rvt'
        if path is not None:
            candidate = Path(path).resolve()
            if not any(candidate.is_relative_to(root) for root in self.read_roots):
                raise ValueError('RVT вне разрешённых корней чтения')
            validate_input(candidate, filename)
            # Stream a private working copy; never change the user's RVT.
            import shutil
            shutil.copyfile(candidate, source)
        else:
            if not isinstance(content_base64, str) or len(content_base64) > RVT_MAX_BYTES * 4 // 3 + 8:
                raise ValueError('RVT превышает 512 МБ; используйте локальный path')
            source.write_bytes(base64.b64decode(content_base64, validate=True))
            validate_input(source, filename)
        identity = import_identity(source, filename)
        target = self.cache / 'models' / identity
        target.mkdir(parents=True, exist_ok=True)
        manifest = target / 'manifest.json'
        if not manifest.exists() or not (target / 'geometry.bin').is_file():
            import_source(str(source), str(target), Path(filename.replace('\\', '/')).name)
        model, _ = self.model(identity)
        return {'model_id': identity, 'statistics': model['statistics'], 'source': model['source'],
            'revit': model.get('revit'),
            'viewer_url': self.viewer_url + '/?model=' + identity,
            'ifc_url': self.viewer_url + '/api/models/' + identity + '/converted.ifc',
            'diagnostics_url': self.viewer_url + '/api/models/' + identity + '/conversion-diagnostics.json'}

    def inspect_rvt(self, path):
        from .rvt import inspect_rvt
        candidate = Path(path).resolve()
        if not any(candidate.is_relative_to(root) for root in self.read_roots):
            raise ValueError('RVT вне разрешённых корней чтения')
        if candidate.suffix.lower() != '.rvt':
            raise ValueError('Нужен файл .rvt')
        return inspect_rvt(candidate)
