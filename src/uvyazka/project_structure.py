"""Shared, versioned source grids and append-only independent readings."""
from contextlib import nullcontext
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re

from .core import connection, encode, now
from .structured_readers import FORMATS, MAX_BYTES, engine, extract
from .document_tables import bounded, number

SQL = """
create table if not exists structure_versions(
 version_id text primary key,doc_id text,sha256 text,engine text,next_unit integer,
 total_units integer,status text,payload text);
create table if not exists structure_units(
 unit_id text primary key,version_id text,unit_index integer,payload text);
create table if not exists structure_tables(
 table_id text primary key,unit_id text,version_id text,search_text text,payload text);
create table if not exists structure_rows(
 table_id text,row_number integer,payload text,primary key(table_id,row_number));
create table if not exists structure_reviews(
 cell_id text,reader text,revision integer,request_id text unique,payload text,
 primary key(cell_id,reader,revision));
create index if not exists structure_units_version on structure_units(version_id,unit_index);
create index if not exists structure_tables_version on structure_tables(version_id,unit_id);
"""


def key(*values):
    return hashlib.sha256(encode(values).encode()).hexdigest()[:40]


def text(value, field, maximum=4000, empty=True):
    if not isinstance(value,str) or len(value)>maximum or (not empty and not value):
        raise ValueError('Invalid '+field)
    return value


def compare(literal, observed, state):
    """Agreement is a reading result, never an accepted engineering value."""
    if state == 'question': return 'question'
    if state == 'unreadable': return 'unreadable'
    if state != literal['state']: return 'discrepancy'
    if literal['text'] == observed: return 'matches_literal'
    # Only full scalar decimals, no ranges, units, thousands separators or formulas.
    pattern = r'[+-]?\d+(?:[.,]\d+)?'
    if isinstance(observed,str) and isinstance(literal['text'],str) and all(
            re.fullmatch(pattern,v.strip()) for v in (observed,literal['text'])):
        try:
            if Decimal(observed.replace(',','.')) == Decimal(literal['text'].replace(',','.')):
                return 'matches_numeric'
        except InvalidOperation: pass
    return 'discrepancy'


def profile(rows):
    """Navigation hypotheses supported by raw header addresses, not GOST certification."""
    words = ' '.join(str(c.get('text') or '') for row in rows[:5] for c in row).casefold()
    choices = [
        ('room_explication',('помещ','площад')),
        ('equipment_specification',('наименован','кол','ед')),
        ('project_composition',('обозначен','наименован','том')),
        ('quantities',('объем','работ')),
        ('technical_indicators',('показател','значен'))]
    candidates = [name for name,tokens in choices if all(token in words for token in tokens)]
    from .units import resolve_unit
    headers=[];paths={}
    stems=('наименован','обозначен','колич','кол.','площад','номер','позиц','ед.','единиц','показател','значен','примечан')
    for row in rows[:5]:
        usable=[c for c in row if c.get('text') and c['state'] not in {'merged_continuation','formula'}]
        if not any(any(stem in c['text'].casefold() for stem in stems) or resolve_unit(c['text'].strip()) for c in usable):
            continue
        headers.extend(usable)
        for c in usable:
            span=c.get('merge',{}).get('column_span',c.get('column_span',1))
            for column in range(c['column'],c['column']+span):
                paths.setdefault(column,[]).append(dict(cell_id=c['cell_id'],text=c['text'][:300],
                    text_truncated=len(c['text'])>300,locator=c['locator']))
    return dict(status='heuristic_candidate',revision='header-hints-v1',types=candidates,
                header_cell_candidates=[c['cell_id'] for c in headers],
                column_header_candidates=[dict(column=c,path=p) for c,p in sorted(paths.items())],accepted=False)


class ProjectStructure:
    def __init__(self,workspace,project_id):
        self.workspace,self.project_id=workspace,project_id
        self.path=workspace.db_path(project_id)
        with connection(self.path) as db: db.executescript(SQL)

    def build(self,doc_id=None,unit_limit=5,document_limit=3,retry_failed=False):
        number(unit_limit,'unit_limit',1,10);number(document_limit,'document_limit',1,10)
        if type(retry_failed) is not bool:raise ValueError('retry_failed must be boolean')
        if doc_id is not None:text(doc_id,'doc_id',200,False)
        with connection(self.path,readonly=True) as db:
            documents=[dict(r) for r in db.execute('select * from documents where (? is null or doc_id=?) order by relative_path',(doc_id,doc_id))]
        if doc_id and not documents: raise ValueError('Unknown document')
        processed=[]
        for doc in documents:
            if doc['extension'] not in FORMATS or not doc['sha256']: continue
            revision=engine(doc['extension']); vid=key(self.project_id,doc['doc_id'],doc['sha256'],revision)
            with connection(self.path,readonly=True) as db:
                old=db.execute('select * from structure_versions where version_id=?',(vid,)).fetchone()
            if old and (old['status'] in {'indexed','partial'} or (old['status']=='failed' and not retry_failed)): continue
            start=old['next_unit'] if old else 0
            source=dict(doc_id=doc['doc_id'],sha256=doc['sha256'],relative_path=doc['relative_path'])
            try:
                record,path=self.workspace.source_record(self.project_id,doc['doc_id'])
                if record['sha256']!=doc['sha256']: raise ValueError('Registered source changed; rescan')
                if not path.is_file() or path.stat().st_size>MAX_BYTES: raise ValueError('Source unavailable or exceeds 64 MiB')
                with path.open('rb') as stream: data=stream.read(MAX_BYTES+1)
                if len(data)>MAX_BYTES or hashlib.sha256(data).hexdigest()!=doc['sha256']:
                    raise ValueError('Source changed; rescan')
                if doc['extension']=='.pdf':
                    from .pdf_source import open_pdf
                    context=open_pdf(self.workspace,self.project_id,doc['doc_id'],doc['sha256'])
                else: context=nullcontext(None)
                with context as pdf: total,units=extract(data,doc['extension'],start,unit_limit,pdf)
                if self.workspace.source_state(self.project_id,doc['doc_id'],full_hash=True)['status']!='content_hash_matches':
                    raise ValueError('Source changed during extraction; rescan')
                with connection(self.path) as db:
                    db.execute('begin immediate')
                    current=db.execute('select sha256 from documents where doc_id=?',(doc['doc_id'],)).fetchone()
                    if not current or current[0]!=doc['sha256']: raise ValueError('Source revision changed during extraction')
                    concurrent=db.execute('select next_unit from structure_versions where version_id=?',(vid,)).fetchone()
                    if concurrent and concurrent[0]>start:
                        processed.append(dict(**source,status='advanced_by_another_worker',processed_units=0))
                        if len(processed)>=document_limit:break
                        continue
                    for unit in units:
                        uid=key(vid,unit['index']); unit.update(unit_id=uid,version_id=vid,source=source,engine=revision)
                        cards=[]
                        for ordinal,t in enumerate(unit.pop('tables'),1):
                            tid=key(uid,ordinal); rows=t.pop('rows')
                            for row in rows:
                                for c in row: c['cell_id']=f'{tid}:{c["row"]}:{c["column"]}'
                            t.update(table_id=tid,unit_id=uid,version_id=vid,source=source,
                                     unit_name=unit['name'],unit_kind=unit['kind'],engine=revision,
                                     profile_candidate=profile(rows),interpretation_status='literal_not_approved')
                            search=' '.join(str(c.get('text') or '') for row in rows for c in row)
                            db.execute('insert or ignore into structure_tables values(?,?,?,?,?)',(tid,uid,vid,search,encode(t)))
                            for r,row in enumerate(rows,1):
                                db.execute('insert or ignore into structure_rows values(?,?,?)',(tid,r,encode(row)))
                            cards.append(tid)
                        unit['table_ids']=cards
                        db.execute('insert or ignore into structure_units values(?,?,?,?)',(uid,vid,unit['index'],encode(unit)))
                    next_unit=start+len(units)
                    if next_unit < total and not units: raise ValueError('Reader made no progress')
                    warnings=any(u['warnings'] for u in units) or bool(old and json.loads(old['payload']).get('has_warnings'))
                    status='pending' if next_unit<total else ('partial' if warnings else 'indexed')
                    payload=dict(source=source,has_warnings=warnings,updated_at=now(),engineering_review='unchecked')
                    db.execute('insert or replace into structure_versions values(?,?,?,?,?,?,?,?)',
                               (vid,doc['doc_id'],doc['sha256'],revision,next_unit,total,status,encode(payload)))
                processed.append(dict(**source,status=status,processed_units=len(units),next_unit=next_unit,total_units=total))
            except Exception as exc:
                # Explicit terminal failure, retried only on request; intake must not spin forever.
                payload=dict(source=source,error=type(exc).__name__+': '+str(exc)[:1000],updated_at=now())
                with connection(self.path) as db:
                    db.execute('begin immediate')
                    concurrent=db.execute('select next_unit from structure_versions where version_id=?',(vid,)).fetchone()
                    if not concurrent or concurrent[0]<=start:
                        db.execute('insert or replace into structure_versions values(?,?,?,?,?,?,?,?)',
                                   (vid,doc['doc_id'],doc['sha256'],revision,start,None,'failed',encode(payload)))
                processed.append(dict(**source,status='failed',error=payload['error']))
            if len(processed)>=document_limit: break
        return dict(project_id=self.project_id,processed=processed,coverage=self.coverage())

    def coverage(self):
        counts=dict(documents=0,supported_documents=0,unsupported_documents=0,unhashed_documents=0,
                    pending_documents=0,indexed_documents=0,partial_documents=0,failed_documents=0,
                    indexed_units=0,total_known_units=0,tables=0,stored_rows=0,reviewed_cells=0)
        with connection(self.path,readonly=True) as db:
            docs=[dict(r) for r in db.execute('select doc_id,sha256,extension from documents')]
            counts['documents']=len(docs)
            for d in docs:
                if d['extension'] not in FORMATS: counts['unsupported_documents']+=1;continue
                counts['supported_documents']+=1
                if not d['sha256']: counts['unhashed_documents']+=1;continue
                vid=key(self.project_id,d['doc_id'],d['sha256'],engine(d['extension']))
                v=db.execute('select * from structure_versions where version_id=?',(vid,)).fetchone()
                counts[(v['status'] if v else 'pending')+'_documents']+=1
                if v:
                    counts['indexed_units']+=v['next_unit']
                    counts['total_known_units']+=v['total_units'] or 0
                    counts['tables']+=db.execute('select count(*) from structure_tables where version_id=?',(vid,)).fetchone()[0]
                    counts['stored_rows']+=db.execute('select count(*) from structure_rows r join structure_tables t on t.table_id=r.table_id where t.version_id=?',(vid,)).fetchone()[0]
            counts['reviewed_cells']=db.execute('select count(distinct cell_id) from structure_reviews').fetchone()[0]
        return {**counts,'source_freshness':'registered_hash_navigation_only',
                'note':'Extraction coverage is not engineering review. Reviewed cells includes history; unknown total units remain unknown.'}

    def catalog(self,kind='sheets',query='',doc_id=None,offset=0,limit=40):
        number(offset,'offset');number(limit,'limit',1,100);text(query,'query',500)
        if kind not in {'sheets','tables','documents'}: raise ValueError('Unknown structure kind')
        with connection(self.path,readonly=True) as db:
            documents={r['doc_id']:dict(r) for r in db.execute('select doc_id,relative_path,sha256,extension from documents')}
            if kind=='documents':
                items=[]
                for d in documents.values():
                    if doc_id and doc_id!=d['doc_id']:continue
                    v=db.execute('select * from structure_versions where version_id=?',
                        (key(self.project_id,d['doc_id'],d['sha256'],engine(d['extension'])),)).fetchone()
                    items.append({**d,'status':v['status'] if v else ('unsupported' if d['extension'] not in FORMATS else 'not_built'),
                                  'progress':dict(v) if v else None})
            else:
                revisions=sorted({engine(suffix) for suffix in FORMATS})
                names=','.join('?' for _ in revisions)
                search="x.payload || ' ' || d.relative_path" if kind=='sheets' else "x.search_text || ' ' || x.payload || ' ' || d.relative_path"
                name='structure_units' if kind=='sheets' else 'structure_tables'
                unit_join='' if kind=='sheets' else ' join structure_units u on u.unit_id=x.unit_id '
                where=f''' from {name} x {unit_join} join structure_versions v on v.version_id=x.version_id
                    join documents d on d.doc_id=v.doc_id and d.sha256=v.sha256
                    where v.engine in ({names}) and (? is null or d.doc_id=?)
                    and instr(casefold({search}),casefold(?))>0'''
                args=(*revisions,doc_id,doc_id,query)
                total=db.execute('select count(*)'+where,args).fetchone()[0]
                order='d.relative_path,x.unit_index' if kind=='sheets' else """d.relative_path,u.unit_index,
                    (select cast(key as integer) from json_each(u.payload,'$.table_ids') where value=x.table_id)"""
                items=[json.loads(r[0]) for r in db.execute('select x.payload'+where+' order by '+order+' limit ? offset ?',(*args,limit,offset))]
                return bounded(dict(project_id=self.project_id,kind=kind,items=items,total=total,
                    next_offset=offset+limit if offset+limit<total else None,coverage=self.coverage()))
        items=[i for i in items if query.casefold() in encode(i).casefold()]
        items.sort(key=lambda i:(i.get('relative_path') or i.get('source',{}).get('relative_path',''),
                                 i.get('index',0),i.get('name',''),i.get('table_id','')))
        return bounded(dict(project_id=self.project_id,kind=kind,items=items[offset:offset+limit],
                            total=len(items),next_offset=offset+limit if offset+limit<len(items) else None,
                            coverage=self.coverage()))

    def read(self,table_id,offset=0,limit=40,column_offset=0,column_limit=20,verify_source=True):
        text(table_id,'table_id',100,False)
        number(offset,'offset');number(limit,'limit',1,100)
        number(column_offset,'column_offset');number(column_limit,'column_limit',1,50)
        with connection(self.path,readonly=True) as db:
            row=db.execute('select payload from structure_tables where table_id=?',(table_id,)).fetchone()
            if not row: raise ValueError('Unknown table in this project')
            card=json.loads(row[0]); source=card['source']
            rows=[]
            for record in db.execute('select payload from structure_rows where table_id=? and row_number>? order by row_number limit ?',
                                     (table_id,offset,limit)):
                cells=[c for c in json.loads(record[0]) if column_offset<c['column']<=column_offset+column_limit]
                for c in cells:
                    reviews=[json.loads(r[0]) for r in db.execute('select payload from structure_reviews where cell_id=? order by revision',(c['cell_id'],))]
                    c['readings']={r['reader']:r for r in reviews}
                rows.append(cells)
        registered,_=self.workspace.source_record(self.project_id,source['doc_id'])
        current=registered['sha256']==source['sha256'] and card['engine']==engine(registered['extension'])
        freshness=self.workspace.source_state(self.project_id,source['doc_id'],full_hash=True) if verify_source else {'status':'not_verified'}
        current=current and (freshness['status']=='content_hash_matches' if verify_source else True)
        if not current:
            for row in rows:
                for c in row:
                    for reading in c['readings'].values():
                        reading['recorded_comparison']=reading['comparison'];reading['comparison']='stale'
        return bounded(dict(project_id=self.project_id,table=card,rows=rows,current_registered_version=current,
                            source_freshness=freshness,
                            next_offset=offset+limit if offset+limit<card['row_count'] else None,
                            next_column_offset=column_offset+column_limit if column_offset+column_limit<card['column_count'] else None,
                            accepted=False))

    def review(self,cell_id,reader,observed_text,state,method,request_id,reason='',expected_revision=0):
        text(cell_id,'cell_id',100,False);text(request_id,'request_id',100,False)
        if reader not in {'model','human'}:raise ValueError('Reader must be model or human')
        if method not in {'visual_original','native_source','cached_extraction'}:raise ValueError('Unknown reading method')
        if state not in {'value','empty','absent','formula','merged_continuation','unresolved_empty','unresolved_or_merged','unresolved_merge','question','unreadable'}:
            raise ValueError('Unknown observed state')
        if observed_text is not None:text(observed_text,'observed_text',10000)
        text(reason,'reason',4000);number(expected_revision,'expected_revision')
        if state in {'question','unreadable'} and not reason.strip():raise ValueError('Explain the question or unreadable area')
        if state=='value' and not observed_text:raise ValueError('Value needs literal text; zero is a value')
        if state=='empty' and observed_text!='':raise ValueError('Empty state requires an empty string')
        if state in {'absent','merged_continuation'} and observed_text is not None:raise ValueError('Absent/merged state requires null')
        request=dict(cell_id=cell_id,reader=reader,observed_text=observed_text,state=state,method=method,
                     reason=reason,expected_revision=expected_revision)
        tid,r,c=cell_id.rsplit(':',2);r=int(r);c=int(c)
        with connection(self.path) as db:
            db.execute('begin immediate')
            retry=db.execute('select payload from structure_reviews where request_id=?',(request_id,)).fetchone()
            if retry:
                saved=json.loads(retry[0])
                if saved['request']!=request:raise ValueError('request_id already used for different reading')
                return saved
            card=db.execute('select payload from structure_tables where table_id=?',(tid,)).fetchone()
            row=db.execute('select payload from structure_rows where table_id=? and row_number=?',(tid,r)).fetchone()
            if not card or not row:raise ValueError('Unknown source cell')
            literal=next((item for item in json.loads(row[0]) if item['column']==c),None)
            if not literal or literal['cell_id']!=cell_id:raise ValueError('Unknown source cell')
            last=db.execute('select max(revision) from structure_reviews where cell_id=? and reader=?',(cell_id,reader)).fetchone()[0] or 0
            if last!=expected_revision:raise ValueError('Reading revision conflict; read the cell again')
            if last and not reason.strip():raise ValueError('Correction needs a reason')
            source=json.loads(card[0])['source']
            registered=db.execute('select sha256 from documents where doc_id=?',(source['doc_id'],)).fetchone()
            fresh=self.workspace.source_state(self.project_id,source['doc_id'],full_hash=True)['status']=='content_hash_matches'
            result=dict(request=request,cell_id=cell_id,reader=reader,revision=last+1,request_id=request_id,
                        source=source,locator=literal['locator'],observed_text=observed_text,state=state,reason=reason,
                        method=method,independence='declared_original_reading' if method!='cached_extraction' else 'not_independent',
                        comparison=compare(literal,observed_text,state) if registered and registered[0]==source['sha256'] and fresh else 'stale',
                        accepted=False,created_at=now())
            db.execute('insert into structure_reviews values(?,?,?,?,?)',(cell_id,reader,last+1,request_id,encode(result)))
            db.execute('insert into events(created_at,kind,payload) values(?,?,?)',(now(),'structure_reading',encode(result)))
        return result
