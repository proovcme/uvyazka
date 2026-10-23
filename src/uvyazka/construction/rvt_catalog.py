"""One project store for native and browser RVT catalogues. No RVT upload required."""
from __future__ import annotations
import json
import re
from pathlib import Path

from ..core import connection, encode, now, digest
from .rvt_data import RvtData, objects
from .simulation import canonical_hash

MAX_BYTES = 128 * 1024 * 1024
SQL = 'create table if not exists rvt_catalog_metadata(extraction_id text primary key,payload text not null)'


def valid_id(value):
    return (isinstance(value, str) and bool(re.fullmatch(r'-?\d{1,24}', value)) or
            type(value) is int and abs(value) <= 9007199254740991)


def validate(document):
    if not isinstance(document, dict) or type(document.get('schema_version')) is not int or document.get('schema_version') != 1:
        raise ValueError('RVT catalogue schema_version must be 1')
    if not isinstance(document.get('status'),str) or type(document.get('clipped_records')) is not int or document['clipped_records']<0:
        raise ValueError('Catalogue status and omitted-record count required')
    source = document.get('source', {})
    if not isinstance(source, dict) or not re.fullmatch('[0-9a-f]{64}', str(source.get('sha256', ''))):
        raise ValueError('Exact source RVT SHA-256 required')
    if not isinstance(source.get('filename'), str) or len(source['filename']) > 1024:
        raise ValueError('Source filename required')
    if type(source.get('size_bytes')) is not int or source['size_bytes'] <= 0:
        raise ValueError('Positive source size required')
    if document.get('evaluated_schedule_body_available') is not False:
        raise ValueError('Catalogue must explicitly identify saved, unevaluated data')
    records = document.get('records')
    if not isinstance(records, list) or len(records) > 100000:
        raise ValueError('Bounded catalogue records required')
    schedule = document.get('schedule_data')
    if schedule is not None and (not isinstance(schedule, dict) or schedule.get('source_sha256') != source['sha256']):
        raise ValueError('Schedule parameters belong to another source RVT')
    parameters = schedule.get('records', []) if schedule else []
    if not isinstance(parameters, list) or len(parameters) > 100000:
        raise ValueError('Bounded parameter records required')
    for rows, catalogue in [(records, True), (parameters, False)]:
        ids = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('identity'),dict) or not valid_id(row['identity'].get('element_id')):
                raise ValueError('Exact, safe Revit ElementId required')
            eid = str(row['identity']['element_id'])
            if eid in ids:
                raise ValueError('Duplicate Revit identity in catalogue')
            ids.add(eid)
            if not isinstance(row.get('class_name'), str) or not isinstance(row.get('status'), str) or 'source' not in row:
                raise ValueError('Native record class/status required')
            if catalogue and row.get('kind') not in {'view', 'schedule', 'placement'}:
                raise ValueError('Catalogue kind must be view, schedule or placement')
            if not catalogue and (row['class_name'] not in {'FamilyInstance','FamilySymbol'} or row.get('kind','element')!='element'):
                raise ValueError('Schedule parameter scope must be FamilyInstance or FamilySymbol')
            if row.get('saved_metadata') is not None and not isinstance(row['saved_metadata'],dict):
                raise ValueError('Saved parameter metadata must be an object')
            if 'root_fields' in row and not isinstance(row['root_fields'],dict):
                raise ValueError('Saved root fields must be an object')
            graph = row.get('graph')
            if graph is not None:
                if not isinstance(graph, dict) or not isinstance(graph.get('objects'), list) or not isinstance(graph.get('edges'), list):
                    raise ValueError('Invalid native graph')
                for obj in graph['objects']:
                    if not isinstance(obj, dict) or not isinstance(obj.get('class_name'), str) or not isinstance(obj.get('fields'), dict):
                        raise ValueError('Invalid native object')
                for edge in graph['edges']:
                    if not isinstance(edge, dict) or any(type(edge.get(k)) is not int for k in ['source_object_index', 'target_object_index', 'pointer_offset']):
                        raise ValueError('Invalid graph edge')
                    if any(not 0 <= edge[k] < len(graph['objects']) for k in ['source_object_index', 'target_object_index']):
                        raise ValueError('Graph edge outside record')
    if set(str(r['identity']['element_id']) for r in records) & set(str(r['identity']['element_id']) for r in parameters):
        raise ValueError('Catalogue and parameter identities overlap')
    if len(json.dumps(document,ensure_ascii=False,allow_nan=False).encode('utf-8')) > MAX_BYTES:
        raise ValueError('Catalogue exceeds storage budget')
    return records, parameters


class RvtCatalog:
    def __init__(self, workspace):
        self.workspace = workspace
        self.data = RvtData(workspace)

    def save(self, project_id, document, request_id, artifact=None):
        self.workspace.project(project_id)
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise ValueError('request_id: 1–128 characters')
        if isinstance(document,dict):document={k:v for k,v in document.items() if k!='shared_store'}
        records, parameters = validate(document)
        fingerprint = canonical_hash(['rvt-catalog-v1', document, artifact])
        source = dict(document['source'])
        source['locator'] = 'Saved RVT catalogue imported into project'
        source['source_verification'] = 'declared_sha256_not_reopened'
        path = self.data.db(project_id)
        rows = []
        counts = {}
        for row in [*records, *parameters]:
            kind = row.get('kind', 'element')
            counts[kind] = counts.get(kind, 0) + 1
            fields = objects(row)[0]['fields'] if objects(row) else row.get('root_fields', {})
            rows.append((fingerprint, len(rows), str(row['identity']['element_id']), row['class_name'], kind,
                         str(fields.get('m_viewName') or fields.get('m_name') or ''), row['status'], encode(row)))
        metadata = {k: v for k, v in document.items() if k not in {'records', 'schedule_data', 'shared_store'}}
        if document.get('schedule_data') is not None:
            metadata['schedule_data'] = {k: v for k, v in document['schedule_data'].items() if k != 'records'}
        metadata['catalogue_record_count'] = len(records)
        result = {'project_id': project_id, 'extraction_id': fingerprint, 'source': source, 'profile': 'catalog',
                  'created_at': now(), 'origin': 'browser_catalogue', 'catalog_artifact': artifact,
                  'status': 'partial' if document.get('status') == 'partial' or (document.get('schedule_data') or {}).get('status') == 'partial' else 'saved_requires_review',
                  'catalog_status': document.get('status'), 'counts': counts, 'record_count': len(rows),
                  'catalogue_record_count': len(records), 'value_semantics': 'serialized_not_evaluated',
                  'requires_revit': False, 'evaluated_schedule_body_available': False}
        with connection(path) as db:
            db.execute(SQL)
            db.execute('begin immediate')
            old = db.execute('select fingerprint,payload from rvt_data_requests where request_id=?', (request_id,)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise ValueError('request_id already used for a different catalogue')
                return json.loads(old['payload'])
            existing = db.execute('select payload from rvt_extractions where extraction_id=?', (fingerprint,)).fetchone()
            if existing:
                result = json.loads(existing[0])
            else:
                db.execute('insert into rvt_extractions values (?,?)', (fingerprint, encode(result)))
                db.executemany('insert into rvt_native_records values (?,?,?,?,?,?,?,?)', rows)
                db.execute('insert into rvt_catalog_metadata values (?,?)', (fingerprint, encode(metadata)))
                db.execute('insert into events(created_at,kind,payload) values (?,?,?)', (now(), 'rvt_catalog_saved', encode(result)))
            db.execute('insert into rvt_data_requests values (?,?,?)', (request_id, fingerprint, encode(result)))
        return result

    def import_document(self, project_id, doc_id, request_id):
        record, path = self.workspace.source_record(project_id, doc_id)
        if path.suffix.lower() != '.json' or not 0 < path.stat().st_size <= MAX_BYTES:
            raise ValueError('Registered JSON catalogue required')
        before = digest(path)
        if record.get('sha256') and record['sha256'] != before:
            raise ValueError('Catalogue source changed; rescan first')
        document = json.loads(path.read_text(encoding='utf-8-sig'))
        if digest(path) != before:
            raise ValueError('Catalogue changed while reading')
        return self.save(project_id, document, request_id, {'doc_id': doc_id, 'sha256': before})

    def list(self, project_id, source_sha256='', offset=0, limit=40):
        if source_sha256 and not re.fullmatch('[0-9a-f]{64}', source_sha256):
            raise ValueError('Invalid RVT source SHA-256')
        path = self.data.db(project_id)
        with connection(path, readonly=True) as db:
            rows = [json.loads(r[0]) for r in db.execute('select payload from rvt_extractions')]
        rows = [r for r in rows if not source_sha256 or r['source']['sha256'] == source_sha256]
        rows.sort(key=lambda r: r['created_at'], reverse=True)
        from .planning import bounded
        return {'project_id': project_id, **bounded(rows, offset, limit)}

    def document(self, project_id, extraction_id):
        snapshot = self.data.snapshot(project_id, extraction_id)
        path = self.data.db(project_id)
        with connection(path) as db:
            db.execute(SQL)
            meta = db.execute('select payload from rvt_catalog_metadata where extraction_id=?', (extraction_id,)).fetchone()
            rows=[];budget=0;clipped=0
            for stored in db.execute("select kind,payload from rvt_native_records where extraction_id=? and (kind in ('view','schedule','placement') or class_name in ('FamilyInstance','FamilySymbol')) order by record_id", (extraction_id,)):
                row=json.loads(stored['payload']);kind=stored['kind']
                if not meta and kind=='element':
                    fields=objects(row)[0]['fields'] if objects(row) else row.get('root_fields',{})
                    row={**{k:row.get(k) for k in ['identity','class_name','status','diagnostic','source','saved_metadata','metadata_diagnostic']},
                         'root_fields':{k:v for k,v in fields.items() if k in {'m_masterSymbolId','m_familyId','m_createdPhaseId','m_demolishedPhaseId','m_designOptionId','m_name','m_categoryId'}}}
                size=len(encode(row).encode('utf-8'))
                if not meta and budget+size>120*1024*1024:
                    row={k:v for k,v in row.items() if k not in {'graph','saved_metadata'}}
                    row.update(status='output_budget_exceeded',diagnostic='Viewer projection budget exceeded; original record remains in project DB')
                    clipped+=1
                else:budget+=size
                rows.append((kind,row))
        if meta:
            document = json.loads(meta[0]); document.pop('catalogue_record_count', None)
        else:
            # Native MCP extraction is projected from the SAME stored records.
            document = {'schema_version': 1, 'schema_sha256': '', 'summary': {}, 'status': 'partial',
                        'clipped_records': 0, 'evaluated_schedule_body_available': False,
                        'error': snapshot.get('error')}
            document['source'] = {'filename': snapshot['source'].get('filename', 'RVT'), 'sha256': snapshot['source']['sha256'], 'size_bytes': snapshot['source'].get('size_bytes')}
            doc_id = snapshot['source'].get('doc_id')
            if doc_id:
                record, source = self.workspace.source_record(project_id, doc_id)
                document['source'].update(filename=source.name, size_bytes=record.get('size_bytes'))
            report_path = snapshot.get('summary_file')
            if report_path and Path(report_path).is_file():
                report = json.loads(Path(report_path).read_text(encoding='utf-8'))
                document['summary'] = report.get('summary', {})
            elif report_path:
                document['error']='Native summary file unavailable; catalogue records remain in the project DB'
            # No guessed inheritance or reinterpretation of native record classes.
            parameters = [r for kind, r in rows if kind == 'element' and r.get('saved_metadata') is not None]
            if parameters:
                document['schedule_data'] = {'status': 'partial', 'source_sha256': snapshot['source']['sha256'], 'scope': ['available_native_records'], 'records': parameters}
            document['clipped_records']=clipped
        document['records'] = [{**r, 'kind': kind} for kind, r in rows if kind in {'view', 'schedule', 'placement'}]
        if meta and 'schedule_data' in document:
            document['schedule_data']['records'] = [r for kind, r in rows if kind == 'element']
        document['shared_store'] = {'project_id': project_id, 'extraction_id': extraction_id, 'origin': snapshot.get('origin', 'native_extraction'), 'source_verification': snapshot['source'].get('source_verification', 'registered_source_at_extraction')}
        return document

    def for_source(self, project_id, source_sha256):
        snapshots = self.list(project_id, source_sha256, limit=200)['items']
        for snapshot in snapshots:
            if any(snapshot.get('counts', {}).get(k, 0) for k in ['view', 'schedule', 'placement']):
                return self.document(project_id, snapshot['extraction_id'])
        return None
