"""Resumable, source-scoped work. The caller supplies every engineering judgment.

An immutable selected inventory prevents a later session from silently dropping
unfinished units. Results pin a check in one exact analysis revision, not a mutable
title. There is no model runner, approval workflow or background polling here.
"""
import json
import re
from collections import Counter

from .core import connection, encode, now
from .document_tables import bounded, fingerprint, number
from .structure_analysis import StructureAnalysis
from .structured_readers import engine

SQL = '''
create table if not exists review_tasks(
 task_id text, revision integer, payload text, primary key(task_id,revision));
create table if not exists review_task_requests(
 request_id text primary key, fingerprint text, payload text);
'''
OUTCOMES = {'match', 'discrepancy', 'question', 'unchecked'}
STATES = {'pending', 'working', 'blocked', 'reviewed'}


def identifier(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'[\w.-]{1,80}', value):
        raise ValueError('Invalid ' + name)
    return value


def text(value, name, limit=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError('Invalid ' + name)
    return value


class ReviewWork:
    def __init__(self, workspace, project_id):
        self.workspace, self.project_id = workspace, project_id
        self.path = workspace.db_path(project_id)
        self.analyses = StructureAnalysis(workspace, project_id)
        with connection(self.path) as db:
            db.executescript(SQL)

    def anchor(self, db, source, cache):
        allowed = {'doc_id', 'sha256', 'page_number', 'table_id', 'row_number', 'engine'}
        if not isinstance(source, dict) or set(source) - allowed:
            raise ValueError('Use doc_id/sha256 and optional PDF page or table/row anchor')
        record, _ = self.workspace.source_record(self.project_id, source.get('doc_id'))
        if not source.get('sha256') or record['sha256'] != source['sha256']:
            raise ValueError('Source changed; scan and reread before selecting work')
        item = dict(doc_id=record['doc_id'], sha256=record['sha256'])
        if 'page_number' in source:
            page = source['page_number']
            if record['extension'] != '.pdf' or type(page) is not int or not 1 <= page <= (record['page_count'] or 0):
                raise ValueError('page_number must be a known physical PDF page')
            item['page_number'] = page
        if 'table_id' in source:
            card = self.analyses.table(db, source['table_id'])
            if any(card['source'][k] != item[k] for k in ('doc_id', 'sha256')):
                raise ValueError('Table and source do not match')
            if card['engine'] != engine(record['extension']):
                raise ValueError('Table reader changed; rebuild source structure')
            if 'page_number' in source and card.get('unit_kind') != 'pdf_page':
                raise ValueError('Physical page cannot identify an office worksheet')
            if 'page_number' in source and card.get('unit_index') != source['page_number']:
                # Some card versions expose the unit index only via the unit record.
                unit = db.execute('select payload from structure_units where unit_id=?', (card['unit_id'],)).fetchone()
                if not unit or json.loads(unit[0])['index'] != source['page_number']:
                    raise ValueError('Table belongs to another PDF page')
            item.update(table_id=card['table_id'], engine=card['engine'])
            if 'row_number' in source:
                row = source['row_number']
                number(row, 'row_number', 1)
                if not db.execute('select 1 from structure_rows where table_id=? and row_number=?', (card['table_id'], row)).fetchone():
                    raise ValueError('Unknown source row')
                item['row_number'] = row
        elif 'row_number' in source or 'engine' in source:
            raise ValueError('row_number/engine requires table_id')
        if not self.anchor_state(item, True, cache)['current']:
            raise ValueError('Source changed; refresh selected sources')
        return item

    def anchor_state(self, source, verify, cache):
        key = (source['doc_id'], source['sha256'], source.get('engine'))
        if key not in cache:
            record, _ = self.workspace.source_record(self.project_id, source['doc_id'])
            current = record['sha256'] == source['sha256'] and record['index_status'] != 'source_missing'
            if source.get('engine'):
                current = current and source['engine'] == engine(record['extension'])
            freshness = self.workspace.source_state(self.project_id, source['doc_id'], full_hash=True)['status'] if verify else 'registered_hash_only'
            cache[key] = dict(current=current and (not verify or freshness == 'content_hash_matches'), freshness=freshness)
        return cache[key]

    def result(self, db, reference, cache):
        if not isinstance(reference, dict) or set(reference) != {'analysis_id', 'reader', 'revision', 'check_id'}:
            raise ValueError('Result needs analysis_id, reader, revision and check_id')
        identifier(reference['analysis_id'], 'analysis_id')
        identifier(reference['check_id'], 'check_id')
        number(reference['revision'], 'result revision', 1)
        if reference['reader'] not in {'human', 'model'}:
            raise ValueError('Result reader must be model or human')
        key = (reference['analysis_id'], reference['reader'], reference['revision'])
        if key not in cache:
            row = db.execute('select payload from structure_analyses where analysis_id=? and reader=? and revision=?', key).fetchone()
            if not row:
                raise ValueError('Unknown result analysis revision in this project')
            item = json.loads(row[0])
            head = db.execute('select max(revision) from structure_analyses where analysis_id=? and reader=?', key[:2]).fetchone()[0]
            cache[key] = (item, head)
        item, head = cache[key]
        checks = item['data'].get('checks', [])
        found = [c for c in checks if isinstance(c, dict) and c.get('id') == reference['check_id']] if isinstance(checks, list) else []
        if len(found) != 1 or found[0].get('status') not in OUTCOMES:
            raise ValueError('Result must identify one check with a supported status')
        return item, head, found[0]

    def validate_result(self, db, unit, result_cache, source_cache):
        analysis, head, check = self.result(db, unit['result'], result_cache)
        if head != unit['result']['revision'] or not self.analyses.state(analysis, True, source_cache)['current_sources']:
            raise ValueError('Result changed; reread the current analysis and sources')
        dependencies = {(d['source']['doc_id'], d['source']['sha256']) for d in analysis['dependencies']}
        if not all((s['doc_id'], s['sha256']) in dependencies for s in unit['sources']):
            raise ValueError('Result does not cite every selected unit source')
        if unit['state'] == 'reviewed' and check['status'] == 'unchecked':
            raise ValueError('Unchecked result cannot complete a review unit')

    def mutate(self, task_id, request_id, request, actor, reason, action):
        identifier(task_id, 'task_id');text(request_id, 'request_id', 128)
        if actor not in {'model', 'human'}:
            raise ValueError('actor must be model or human')
        text(reason, 'reason')
        try:
            raw = json.loads(json.dumps(request, ensure_ascii=False, allow_nan=False))
        except (ValueError, TypeError) as exc:
            raise ValueError('Finite JSON required') from exc
        if len(encode(raw).encode()) > 128 * 1024:
            raise ValueError('Review request exceeds 128 KiB')
        signature = fingerprint([task_id, raw, actor, reason])
        with connection(self.path) as db:
            db.execute('begin immediate')
            retry = db.execute('select fingerprint,payload from review_task_requests where request_id=?', (request_id,)).fetchone()
            if retry:
                if retry[0] != signature:
                    raise ValueError('request_id already used with different review work')
                return json.loads(retry[1])
            old = db.execute('select payload from review_tasks where task_id=? order by revision desc limit 1', (task_id,)).fetchone()
            previous = json.loads(old[0]) if old else None
            item = action(db, previous, raw)
            item.update(task_id=task_id, project_id=self.project_id, revision=(previous['revision'] if previous else 0)+1,
                        actor=actor, reason=reason, created_at=now(), accepted=False)
            if len(encode(item).encode()) > 128*1024:
                raise ValueError('Review task exceeds 128 KiB; split the selected scope')
            db.execute('insert into review_tasks values(?,?,?)', (task_id, item['revision'], encode(item)))
            receipt = dict(project_id=self.project_id, task_id=task_id, revision=item['revision'], status='work_saved_not_approved')
            db.execute('insert into review_task_requests values(?,?,?)', (request_id, signature, encode(receipt)))
            db.execute('insert into events(created_at,kind,payload) values(?,?,?)', (now(), 'review_work_saved', encode(receipt)))
        return receipt

    def create(self, task_id, title, scope, units, request_id, actor='model'):
        def action(db, previous, raw):
            if previous:
                raise ValueError('Task already exists; read and update it instead of replacing its inventory')
            text(raw['title'], 'title', 300);text(raw['scope'], 'scope', 6000)
            units = raw['units']
            if not isinstance(units, list) or not 1 <= len(units) <= 200:
                raise ValueError('Select 1–200 explicit source rows, objects or checks')
            inventory, seen, cache = [], set(), {}
            for unit in units:
                if not isinstance(unit, dict) or set(unit) != {'id', 'title', 'sources'}:
                    raise ValueError('Unit needs id, title, sources; initial state is pending')
                key = identifier(unit['id'], 'unit id');text(unit['title'], 'unit title', 300)
                if key in seen:
                    raise ValueError('Duplicate unit id')
                seen.add(key)
                if not isinstance(unit['sources'], list) or not 1 <= len(unit['sources']) <= 8:
                    raise ValueError('Each selected unit needs 1–8 source anchors')
                inventory.append(dict(id=key, title=unit['title'], sources=[self.anchor(db, s, cache) for s in unit['sources']],
                                      state='pending', result=None, notes='', actor=actor))
            return dict(title=raw['title'], scope=raw['scope'], units=inventory, complete_project_review=False)
        return self.mutate(task_id, request_id, dict(title=title, scope=scope, units=units), actor, 'Create selected review scope', action)

    def update(self, task_id, updates, expected_revision, request_id, reason, actor='model'):
        number(expected_revision, 'expected_revision', 1)
        def action(db, previous, raw):
            if not previous:
                raise ValueError('Unknown review task in this project')
            if previous['revision'] != raw['expected_revision']:
                raise ValueError('Task revision conflict; reread before continuing')
            updates = raw['updates']
            if not isinstance(updates, list) or not 1 <= len(updates) <= 200:
                raise ValueError('Update 1–200 selected units')
            units = {u['id']: u for u in previous['units']};seen = set();source_cache={};result_cache={}
            for patch in updates:
                if not isinstance(patch, dict) or set(patch)-{'unit_id', 'state', 'result', 'notes', 'sources'} or not set(patch)-{'unit_id'}:
                    raise ValueError('Update needs unit_id and state/result/notes/sources')
                key = patch.get('unit_id')
                if key not in units or key in seen:
                    raise ValueError('Unknown or duplicate unit_id')
                seen.add(key);unit = units[key]
                if 'sources' in patch:
                    if not isinstance(patch['sources'], list) or not 1 <= len(patch['sources']) <= 8:
                        raise ValueError('Unit needs 1–8 source anchors')
                    unit['sources'] = [self.anchor(db, s, source_cache) for s in patch['sources']]
                if 'notes' in patch:
                    if not isinstance(patch['notes'], str) or len(patch['notes'])>4000:
                        raise ValueError('Notes must be text up to 4000 characters')
                    unit['notes'] = patch['notes']
                if 'state' in patch:
                    if patch['state'] not in STATES:
                        raise ValueError('State must be pending, working, blocked or reviewed')
                    unit['state'] = patch['state']
                    if patch['state'] != 'reviewed' and 'result' not in patch:
                        unit['result'] = None
                if 'result' in patch:
                    unit['result'] = patch['result']
                if unit['state'] == 'reviewed' and not unit['result']:
                    raise ValueError('Reviewed unit needs a pinned result check')
                if ('result' in patch and unit['result']) or patch.get('state') == 'reviewed' or 'sources' in patch and unit['result']:
                    self.validate_result(db, unit, result_cache, source_cache)
                    if not all(self.anchor_state(s, True, source_cache)['current'] for s in unit['sources']):
                        raise ValueError('Selected source changed; refresh unit sources')
                unit['actor'] = actor
            return previous
        return self.mutate(task_id, request_id, dict(updates=updates, expected_revision=expected_revision), actor, reason, action)

    def present(self, db, task, verify, source_cache):
        result_cache, analysis_cache, units = {}, {}, []
        for original in task['units']:
            unit = {**original};reasons=[]
            if not all(self.anchor_state(s, verify, source_cache)['current'] for s in unit['sources']):
                reasons.append('source_changed')
            outcome = 'unchecked'
            if unit['result']:
                analysis, head, check = self.result(db, unit['result'], result_cache)
                outcome = check['status']
                if head != unit['result']['revision']:
                    reasons.append('analysis_revision_changed')
                key = (analysis['analysis_id'], analysis['reader'], analysis['revision'])
                if key not in analysis_cache:
                    analysis_cache[key] = self.analyses.state(analysis, verify, source_cache)['current_sources']
                if not analysis_cache[key]:
                    reasons.append('result_source_changed')
            unit.update(effective_state='needs_recheck' if reasons else unit['state'], stale_reasons=reasons,
                        outcome=outcome, accepted=False)
            units.append(unit)
        counts = Counter(u['effective_state'] for u in units)
        outcomes = Counter(u['outcome'] for u in units if u['effective_state'] == 'reviewed')
        next_unit = next((u for state in ('needs_recheck', 'working', 'pending') for u in units if u['effective_state'] == state), None)
        remaining = len(units)-counts['reviewed']
        status = ('needs_recheck' if counts['needs_recheck'] else 'in_progress' if next_unit else 'blocked' if remaining else
                  'reviewed_with_findings' if outcomes['question'] or outcomes['discrepancy'] else 'reviewed_selected_scope')
        return {**task, 'units': units, 'counts': dict(total=len(units), **{k: counts[k] for k in (*sorted(STATES), 'needs_recheck')}),
                'outcomes': {k: outcomes[k] for k in sorted(OUTCOMES)}, 'status': status, 'accepted': False,
                'freshness_method': 'actual_hash' if verify else 'registered_hash_only',
                'next_action': dict(unit_id=next_unit['id'], action='refresh_dependencies' if next_unit['stale_reasons'] else 'read_and_check') if next_unit else None,
                'complete_project_review': False}

    def get(self, task_id=None, offset=0, limit=20, unit_offset=0, unit_limit=40, revision=None, verify_source=True, query=''):
        number(offset, 'offset');number(limit, 'limit', 1, 50)
        number(unit_offset, 'unit_offset');number(unit_limit, 'unit_limit', 1, 100)
        if not isinstance(query, str) or len(query)>500:
            raise ValueError('Query exceeds 500 characters')
        if revision is not None:
            number(revision, 'revision', 1)
            if task_id is None:
                raise ValueError('History requires an exact task_id')
        with connection(self.path, readonly=True) as db:
            if task_id is not None:
                identifier(task_id, 'task_id')
                row = db.execute('select payload from review_tasks where task_id=? and (? is null or revision=?) order by revision desc limit 1', (task_id, revision, revision)).fetchone()
                if not row:
                    raise ValueError('Unknown review task revision in this project')
                item = self.present(db, json.loads(row[0]), verify_source, {})
                head = db.execute('select max(revision) from review_tasks where task_id=?', (task_id,)).fetchone()[0]
                item.update(head_revision=head, historical_revision=item['revision']!=head, unit_offset=unit_offset,
                            next_unit_offset=unit_offset+unit_limit if unit_offset+unit_limit<len(item['units']) else None,
                            units=item['units'][unit_offset:unit_offset+unit_limit])
                return bounded(item)
            where=''' from review_tasks a where revision=(select max(revision) from review_tasks b where b.task_id=a.task_id)
                and instr(casefold(task_id || ' ' || json_extract(payload,'$.title') || ' ' || json_extract(payload,'$.scope')),casefold(?))>0'''
            total = db.execute('select count(*)'+where, (query,)).fetchone()[0]
            cache={};items=[]
            for row in db.execute('select payload'+where+' order by task_id limit ? offset ?', (query, limit, offset)):
                item=self.present(db, json.loads(row[0]), verify_source, cache)
                item.pop('units');items.append(item)
        return bounded(dict(project_id=self.project_id, items=items, total=total, next_offset=offset+limit if offset+limit<total else None))
