"""Immutable, source-addressed model metadata shared by MCP and the local panel."""
from __future__ import annotations
from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

from .core import connection, digest, encode, now
from . import model_readers as readers

SQL = [
    'create table if not exists model_datasets(dataset_id text primary key,payload text not null)',
    'create table if not exists model_objects(dataset_id text,object_id text,ordinal integer,section text,payload text,primary key(dataset_id,object_id),unique(dataset_id,ordinal))',
    'create table if not exists model_read_requests(request_id text primary key,fingerprint text,result text)',
    'create index if not exists model_object_section on model_objects(dataset_id,section,ordinal)',
]


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def preview(value, depth=0):
    """Bound navigation responses; exact report remains addressable as @dataset."""
    if depth > 5:
        return {'preview_truncated': True, 'detail_object_id': '@dataset'}
    if isinstance(value, str) and len(value) > 1000:
        return {'preview_text': value[:1000], 'total_chars': len(value), 'detail_object_id': '@dataset'}
    if isinstance(value, list):
        items = [preview(v, depth+1) for v in value[:12]]
        return items if len(value) <= 12 else {'preview_items': items, 'total_items': len(value), 'detail_object_id': '@dataset'}
    if isinstance(value, dict):
        items = {k: preview(v, depth+1) for k, v in list(value.items())[:30]}
        if len(value) > 30:
            items['preview_truncated'] = True
        return items
    return value


def at(value, path):
    if not isinstance(path, list) or len(path) > 32:
        raise ValueError('JSON path must contain at most 32 keys/indices')
    for key in path:
        if isinstance(value, dict) and isinstance(key, str) and key in value:
            value = value[key]
        elif isinstance(value, list) and type(key) is int and 0 <= key < len(value):
            value = value[key]
        else:
            raise KeyError('JSON path is absent')
    return value


def matches(row, filters):
    for test in filters:
        try:
            value = at(row, test['path'])
            present = True
        except KeyError:
            value, present = None, False
        op, expected = test['op'], test.get('value')
        if op == 'exists':
            ok = present == expected
        elif not present:
            ok = False
        elif op == 'eq':
            ok = type(value) is type(expected) and value == expected
        elif op == 'contains':
            ok = isinstance(value, str) and isinstance(expected, str) and expected.casefold() in value.casefold()
        else:
            numeric = type(value) in (int, float) and type(expected) in (int, float)
            ok = numeric and (value > expected if op == 'gt' else value < expected)
        if not ok:
            return False
    return True


class ModelData:
    def __init__(self, workspace):
        self.workspace = workspace

    def _db(self, project, write=False):
        path = self.workspace.db_path(project)
        if write:
            with connection(path) as db:
                for statement in SQL:
                    db.execute(statement)
        return path

    def _summary(self, project, data, verify_source=False):
        result = {**data, 'coverage': preview(data['coverage']), 'project_id': project, 'approval_status': 'unreviewed', 'detail_object_id': '@dataset'}
        source = data['source']
        if source.get('doc_id'):
            try:
                record, target = self.workspace.source_record(project, source['doc_id'])
                # Binary inventory intentionally need not hash every large model during scan.
                result['current_registered_version'] = record['sha256'] == source['sha256'] if record['sha256'] else None
                stat = target.stat()
                if verify_source:
                    state = 'content_hash_matches' if digest(target) == source['sha256'] else 'needs_refresh'
                else:
                    state = 'snapshot_metadata_matches' if (stat.st_size, stat.st_mtime_ns) == (source['size_bytes'], source['mtime_ns']) else 'needs_refresh'
                result['freshness'] = {'status': state, 'note': 'Metadata matches do not verify bytes or approve a revision.'}
                if result['current_registered_version'] is False:
                    result['freshness'] = {'status': 'different_registered_version', 'current_source_state': result['freshness']}
            except (ValueError, OSError):
                result['freshness'] = {'status': 'source_unavailable'}
        else:
            result['freshness'] = {'status': 'derived_package_only', 'original_file_reopened': False}
        return result

    def dataset(self, project, dataset_id, verify_source=False):
        with connection(self._db(project), readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where name='model_datasets'").fetchone():
                raise ValueError('No model datasets in this project')
            row = db.execute('select payload from model_datasets where dataset_id=?', (dataset_id,)).fetchone()
        if not row:
            raise ValueError('Unknown dataset in selected project')
        return self._summary(project, json.loads(row['payload']), verify_source)

    def list(self, project, offset=0, limit=20):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError('offset >= 0; limit 1..50')
        with connection(self._db(project), readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where name='model_datasets'").fetchone():
                return {'project_id': project, 'items': [], 'total': 0, 'next_offset': None}
            total = db.execute('select count(*) from model_datasets').fetchone()[0]
            rows = db.execute('select payload from model_datasets order by rowid desc limit ? offset ?', (limit, offset)).fetchall()
        return {'project_id': project, 'items': [self._summary(project, json.loads(r['payload'])) for r in rows], 'total': total,
                'next_offset': offset + len(rows) if offset + len(rows) < total else None}

    def read(self, project, request_id, doc_id=None, scene_id=None):
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128 or bool(doc_id) == bool(scene_id):
            raise ValueError('request_id 1..128 and exactly one of doc_id or scene_id required')
        db_path = self._db(project, write=True)
        request_hash = fingerprint([doc_id, scene_id])
        with connection(db_path, readonly=True) as db:
            previous = db.execute('select * from model_read_requests where request_id=?', (request_id,)).fetchone()
        if previous:
            if previous['fingerprint'] != request_hash:
                raise ValueError('request_id reused with different input')
            return self.dataset(project, json.loads(previous['result'])['dataset_id'], True)
        if doc_id:
            record, source = self.workspace.source_record(project, doc_id)
            fmt = source.suffix.lower().lstrip('.')
            engine = readers.reader_status(self.workspace)['readers'].get(fmt)
            if not engine or not engine['available']:
                raise ValueError('Reader unavailable: ' + (engine['setup'] if engine else 'unsupported model format'))
            sha = digest(source)
            stat = source.stat()
            if (record['sha256'] and sha != record['sha256']) or (not record['sha256'] and (stat.st_size, stat.st_mtime_ns) != (record['size_bytes'], record['mtime_ns'])):
                raise ValueError('Source changed; scan the project before reading')
            origin = {'doc_id': doc_id, 'sha256': sha, 'format': fmt, 'relative_path': record['relative_path'], 'original_file_reopened': True,
                      'size_bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns}
            identity = [readers.REVISION, doc_id, sha, fmt, engine['revision']]
        else:
            from .construction.coordination_store import CoordinationStore
            from .construction.viewer_models import validate_package
            model, binary = CoordinationStore(self.workspace).scene(project, scene_id)
            validate_package(model, binary)
            fmt = str(model['source'].get('format', 'unknown')).lower()
            origin = {'scene_id': scene_id, 'model_id': model['model_id'], 'sha256': model['source']['sha256'], 'format': fmt,
                      'original_file_reopened': False, 'package_sha256': fingerprint(model)}
            engine = {'engine': 'viewer ModelPackage metadata', 'revision': readers.REVISION}
            identity = [readers.REVISION, origin]
        dataset_id = fingerprint(identity)
        with connection(db_path, readonly=True) as db:
            cached = db.execute('select 1 from model_datasets where dataset_id=?', (dataset_id,)).fetchone()
        if not cached:
            if scene_id:
                rows, report = self._scene(model)
            elif fmt == 'rvt':
                rows, report = readers.rvt_data(self.workspace, project, doc_id, 'model:' + dataset_id[:48])
            else:
                # Decode a pinned private working copy, never the live original.
                with tempfile.TemporaryDirectory(prefix='model-', dir=db_path.parent) as directory:
                    folder = Path(directory)
                    copied = folder/('source.' + fmt)
                    shutil.copyfile(source, copied)
                    if digest(copied) != sha:
                        raise ValueError('Source changed while copying')
                    if fmt == 'ifc': rows, report = readers.ifc_data(copied)
                    elif fmt == 'dxf': rows, report = readers.dxf_data(copied)
                    elif fmt == 'dwg': rows, report = readers.dwg_data(copied, folder)
                    else: rows, report = readers.nwd_data(self.workspace, copied, folder)
            if doc_id and digest(source) != sha:
                raise ValueError('Source changed during reading; snapshot was not published')
            if doc_id and readers.reader_status(self.workspace)['readers'][fmt]['revision'] != engine['revision']:
                raise ValueError('Reader changed during reading; retry with the current reader')
            if len(rows) > 500_000:
                raise ValueError('Metadata exceeds 500000-object budget')
            records, seen, counts, size = [], set(), Counter(), 0
            for index, row in enumerate(rows):
                if row['section'] not in readers.SECTIONS:
                    raise ValueError('Unknown adapter section')
                key = (row['section'], row['native_id'])
                if key in seen:
                    raise ValueError('Ambiguous duplicate native object; no objects were overwritten')
                seen.add(key)
                oid = fingerprint([dataset_id, *key])
                json.dumps(row, allow_nan=False)
                payload = encode({**row, 'object_id': oid})
                size += len(payload.encode())
                if len(payload.encode()) > 4*1024**2 or size > 128*1024**2:
                    raise ValueError('Metadata exceeds per-object/total output budget')
                counts[row['section']] += 1
                records.append((dataset_id, oid, index, row['section'], payload))
            data = {'dataset_id': dataset_id, 'contract': 'UvyazkaModelData', 'version': 1, 'source': origin, 'reader': engine,
                    'created_at': now(), 'counts': dict(counts), 'object_count': len(rows), 'coverage': report,
                    'original_files_modified': False, 'mesh_buffers_returned': False}
            with connection(db_path) as db:
                db.execute('begin immediate')
                if doc_id:
                    self._pin_source(db, origin)
                if not db.execute('select 1 from model_datasets where dataset_id=?', (dataset_id,)).fetchone():
                    db.execute('insert into model_datasets values(?,?)', (dataset_id, encode(data)))
                    db.executemany('insert into model_objects values(?,?,?,?,?)', records)
        with connection(db_path) as db:
            db.execute('begin immediate')
            if doc_id:
                self._pin_source(db, origin)
            old = db.execute('select fingerprint from model_read_requests where request_id=?', (request_id,)).fetchone()
            if old and old['fingerprint'] != request_hash:
                raise ValueError('request_id reused with different input')
            db.execute('insert or ignore into model_read_requests values(?,?,?)', (request_id, request_hash, encode({'dataset_id': dataset_id})))
        return self.dataset(project, dataset_id, True)

    @staticmethod
    def _pin_source(db, source):
        """An explicit successful model read fills the deferred binary inventory hash."""
        row = db.execute('select sha256,size_bytes,mtime_ns,parser_revision from documents where doc_id=?', (source['doc_id'],)).fetchone()
        if not row or (row['size_bytes'], row['mtime_ns']) != (source['size_bytes'], source['mtime_ns']) or row['sha256'] not in (None, source['sha256']):
            raise ValueError('Registered source changed during reading')
        if row['sha256'] is None:
            db.execute('update documents set sha256=? where doc_id=?', (source['sha256'], source['doc_id']))
            db.execute('insert or ignore into document_versions values(?,?,?,?)', (source['doc_id'], source['sha256'], row['parser_revision'], now()))

    @staticmethod
    def _scene(model):
        rows = []
        for index, element in enumerate(model['elements']):
            ids = {k: v for k, v in {'step_id': element.get('step_id'), 'global_id': element.get('global_id'),
                'element_id': (element.get('revit') or {}).get('element_id'), 'unique_id': (element.get('revit') or {}).get('unique_id')}.items() if v is not None}
            rows.append(readers.obj('elements', element['id'], element.get('name'), element.get('class'),
                {k: v for k, v in element.items() if k not in {'mesh', 'id'}},
                identifiers=ids, semantic_kind=element.get('semantic_kind', 'unknown'), level=element.get('storey_id'),
                quantity_eligible=element.get('quantity_eligible', False),
                evidence={'model_id': model['model_id'], 'element_id': element['id'], 'json_path': ['elements', index]}, value_semantics='viewer_derived; inspect original source before accepting'))
        for section, source_key in [('levels', 'storeys'), ('systems', 'systems'), ('relationships', 'relationships')]:
            for index, item in enumerate(model.get(source_key, [])):
                key = str(item.get('id', item.get('step_id', 'derived:'+str(index))))
                rows.append(readers.obj(section, key, item.get('name'), item.get('class', section), item,
                    evidence={'model_id': model['model_id'], 'json_path': [source_key, index]}, value_semantics='viewer_derived'))
        return rows, {'status': 'partial', 'limitations': ['Derived viewer package only; original file not reopened.', 'Logical nodes/fragments are not automatically physical element counts.']}

    def query(self, project, dataset_id, section='elements', query='', native_id=None, filters=None, cursor=None, limit=40):
        summary = self.dataset(project, dataset_id)
        if section not in readers.SECTIONS or not isinstance(query, str) or len(query) > 256 or type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('Supported section, query <=256 and limit 1..100 required')
        filters = [] if filters is None else filters
        if not isinstance(filters, list) or len(filters) > 8:
            raise ValueError('At most 8 filters')
        for test in filters:
            if not isinstance(test, dict) or set(test) != {'path', 'op', 'value'} or test.get('op') not in {'eq', 'contains', 'exists', 'gt', 'lt'}:
                raise ValueError('Filter needs path, op=eq|contains|exists|gt|lt, value')
            if not isinstance(test.get('path'), list) or len(test['path']) > 32 or any(type(k) not in (str, int) for k in test['path']):
                raise ValueError('Invalid JSON path')
            if test['op'] == 'exists' and type(test.get('value')) is not bool:
                raise ValueError('exists value must be boolean')
        token = fingerprint([dataset_id, section, query, native_id, filters])
        offset = 0
        if cursor:
            try:
                prefix, value = cursor.split(':')
                offset = int(value)
            except (ValueError, AttributeError):
                raise ValueError('Invalid cursor') from None
            if prefix != token or offset < 0:
                raise ValueError('Cursor belongs to a different query')
        items, scanned, last = [], 0, offset
        with connection(self._db(project), readonly=True) as db:
            candidates = db.execute('select ordinal,payload from model_objects where dataset_id=? and section=? and ordinal>=? order by ordinal limit 2001', (dataset_id, section, offset)).fetchall()
        for record in candidates[:2000]:
            row = json.loads(record['payload']); scanned += 1; last = record['ordinal'] + 1
            ids = row.get('identifiers', {})
            if native_id is not None and native_id not in [row['native_id'], *[str(v) for v in ids.values() if isinstance(v, (str, int))]]:
                continue
            if query and query.casefold() not in ' '.join([row['name'], row['category'], row['native_id']]).casefold():
                continue
            if not matches(row, filters):
                continue
            item = {k: row[k] for k in ('object_id', 'native_id', 'section', 'name', 'category', 'identifiers', 'semantic_kind', 'quantity_eligible') if k in row}
            item['name'] = item['name'][:240]; item['category'] = item['category'][:160]
            items.append(item)
            if len(items) == limit:
                break
        more = bool(candidates) and (scanned < len(candidates))
        return {'project_id': project, 'dataset_id': dataset_id, 'source': summary['source'],
                'freshness': summary['freshness'], 'current_registered_version': summary.get('current_registered_version'),
                'items': items, 'scanned': scanned, 'next_cursor': token+':'+str(last) if more else None,
                'coverage_status': summary['coverage']['status'], 'note': 'Search covers this saved partial snapshot only; empty pages can have continuation.'}

    def object(self, project, dataset_id, object_id, json_path=None, offset=0, max_chars=6000, verify_source=False):
        summary = self.dataset(project, dataset_id, verify_source)
        if type(offset) is not int or offset < 0 or type(max_chars) is not int or not 100 <= max_chars <= 12000:
            raise ValueError('offset >=0 and max_chars 100..12000')
        with connection(self._db(project), readonly=True) as db:
            record = db.execute('select payload from model_datasets where dataset_id=?', (dataset_id,)).fetchone() if object_id == '@dataset' else db.execute('select payload from model_objects where dataset_id=? and object_id=?', (dataset_id, object_id)).fetchone()
        if not record:
            raise ValueError('Unknown object in selected dataset')
        path = json_path or []
        value = at(json.loads(record['payload']), path)
        text = encode(value)
        return {'project_id': project, 'dataset_id': dataset_id, 'object_id': object_id, 'source': summary['source'],
                'freshness': summary['freshness'], 'current_registered_version': summary.get('current_registered_version'),
                'json_path': path, 'text': text[offset:offset+max_chars], 'total_chars': len(text),
                'next_offset': offset+max_chars if offset+max_chars < len(text) else None, 'approval_status': 'unreviewed'}
