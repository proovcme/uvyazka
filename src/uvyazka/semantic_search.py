"""Derived, project-scoped retrieval over cached evidence and explicitly saved PDF views."""
import hashlib
import json
import math
import re
import struct
import tempfile
from pathlib import Path

from .core import connection, encode, now
from .document_tables import bounded, number
from .embedding_worker import configuration, provider, WorkerError

REVISION='retrieval-1:utf8-1000-overlap40:prompt1:pdf-region1600-budget560'
SQL='''
create table if not exists semantic_segments(
 id text primary key,doc_id text,sha256 text,reader text,active integer,payload text);
create table if not exists semantic_vectors(
 segment_id text,space_id text,state text,vector blob,error text,updated_at text,
 primary key(segment_id,space_id));
create table if not exists semantic_meta(key text primary key,payload text);
'''


def key(value):return hashlib.sha256(encode(value).encode()).hexdigest()


def cut(text, size):
    return text.encode('utf-8')[:size].decode('utf-8',errors='ignore')


def windows(text):
    start=0
    while start<len(text):
        piece=cut(text[start:start+1000],1000)
        end=start+len(piece)
        if piece.strip():yield start,end,piece
        if end>=len(text):break
        start=max(start+1,end-40)


class SemanticSearch:
    def __init__(self,workspace,project_id):
        self.workspace,self.project_id=workspace,project_id
        self.path=workspace.db_path(project_id)
        with connection(self.path) as db:db.executescript(SQL)

    def sync(self,doc_ids=None):
        if doc_ids is not None:
            if not isinstance(doc_ids,list) or not 1<=len(doc_ids)<=50:raise ValueError('Select 1–50 documents')
            for doc in doc_ids:self.workspace.source_record(self.project_id,doc)
        count=0
        with connection(self.path) as db:
            db.execute('begin immediate')
            if doc_ids:
                db.executemany('update semantic_segments set active=0 where doc_id=?',[(d,) for d in doc_ids])
            else:db.execute('update semantic_segments set active=0')
            def store(item):
                nonlocal count
                item.update(project_id=self.project_id,accepted=False,retrieval_revision=REVISION)
                identifier=key(item);item['segment_id']=identifier
                db.execute('insert into semantic_segments values(?,?,?,?,1,?) on conflict(id) do update set active=1',
                           (identifier,item['doc_id'],item['sha256'],item['parser_revision'],encode(item)))
                count+=1
            for row in db.execute('''select p.*,d.relative_path from pages p join documents d
                on d.doc_id=p.doc_id and d.sha256=p.sha256 and d.parser_revision=p.parser_revision
                where d.index_status in ('text_indexed','empty_text') order by p.doc_id,p.page_number'''):
                if doc_ids and row['doc_id'] not in doc_ids:continue
                for start,end,text in windows(row['text']):
                    store(dict(doc_id=row['doc_id'],sha256=row['sha256'],parser_revision=row['parser_revision'],
                        relative_path=row['relative_path'],page_number=row['page_number'],locator=json.loads(row['locator']),
                        char_start=start,char_end=end,text=text,modality='text',
                        body='title: '+cut(Path(row['relative_path']).name,256)+' | text: '+text))
            if db.execute("select 1 from sqlite_master where name='drawing_records'").fetchone():
                for row in db.execute('''select a.payload from drawing_records a where kind='view' and revision=
                    (select max(revision) from drawing_records b where b.kind=a.kind and b.id=a.id)'''):
                    view=json.loads(row[0]);record,_=self.workspace.source_record(self.project_id,view['doc_id'])
                    if doc_ids and view['doc_id'] not in doc_ids:continue
                    if record['sha256']!=view['sha256'] or record['index_status']=='source_missing':continue
                    store(dict(doc_id=view['doc_id'],sha256=view['sha256'],parser_revision=record['parser_revision'],
                        relative_path=record['relative_path'],page_number=view['page_number'],modality='image',
                        text=view['name'],body=None,locator=dict(kind='pdf_region',pdf_page=view['page_number'],
                            region=view['region'],view_id=view['id'],view_revision=view['revision'],
                            coordinate_system=view['coordinate_system'])))
        return count

    def status(self):
        try: config=configuration(self.workspace.home);error=None
        except (ValueError,OSError) as exc:config=None;error=str(exc)
        with connection(self.path,readonly=True) as db:
            active=db.execute("select payload from semantic_meta where key='active_space'").fetchone()
            active=json.loads(active[0]) if active else None
            counts={r[0]:r[1] for r in db.execute('''select coalesce(v.state,'pending'),count(*)
                from semantic_segments s left join semantic_vectors v on v.segment_id=s.id and v.space_id=?
                join documents d on d.doc_id=s.doc_id and d.sha256=s.sha256 and d.parser_revision=s.reader
                where s.active=1 group by coalesce(v.state,'pending')''',(active['space_id'] if active else '',))}
            pages,documents=db.execute('''select count(*),count(distinct p.doc_id) from pages p join documents d
                on d.doc_id=p.doc_id and d.sha256=p.sha256 and d.parser_revision=p.parser_revision''').fetchone()
            prepared=db.execute('''select count(distinct s.doc_id) from semantic_segments s join documents d
                on d.doc_id=s.doc_id and d.sha256=s.sha256 and d.parser_revision=s.reader where s.active=1''').fetchone()[0]
        return dict(project_id=self.project_id,configured=config is not None,configuration_error=error,
            active_space=active,counts={k:counts.get(k,0) for k in ('ready','pending','failed')},cached_blocks=pages,
            cached_documents=documents,prepared_documents=prepared,
            inventory_prepared=active is not None,source_freshness='registered_versions_only',
            note='Coverage is only the prepared cached text and explicitly saved views; unread sources and unselected regions are outside it.',
            complete_project_review=False,accepted=False)

    def _fresh(self,item,cache,db=None):
        doc=item['doc_id']
        if doc not in cache:
            record,_=self.workspace.source_record(self.project_id,doc)
            cache[doc]=(record,self.workspace.source_state(self.project_id,doc,full_hash=True)['status'])
        record,state=cache[doc]
        current=state=='content_hash_matches' and record['sha256']==item['sha256'] and record['parser_revision']==item['parser_revision']
        if current and item['modality']=='image':
            with connection(self.path,readonly=True) as viewdb:
                revision=viewdb.execute("select max(revision) from drawing_records where kind='view' and id=?",(item['locator']['view_id'],)).fetchone()[0]
            current=revision==item['locator']['view_revision']
        return current

    def _render(self,item,folder):
        from .pdf_source import open_pdf
        import pymupdf
        with open_pdf(self.workspace,self.project_id,item['doc_id'],item['sha256']) as pdf:
            from .measurements import Measurements
            page,_=Measurements.page(pdf,item['page_number'])
            box=pymupdf.Rect(item['locator']['region']);scale=min(3,1600/max(box.width,box.height))
            if box.is_empty or not page.rect.contains(box):raise ValueError('View region outside source page')
            target=Path(folder)/(item['segment_id']+'.png')
            page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),clip=box,alpha=False).save(target)
        return str(target)

    def build(self,limit=24,doc_ids=None,retry_failed=False):
        number(limit,'limit',1,64)
        if type(retry_failed) is not bool:raise ValueError('retry_failed must be a boolean')
        config=configuration(self.workspace.home)
        if not config:raise ValueError('Configure the optional embedding worker first')
        self.sync(doc_ids)
        cache={};processed=[];errors=[]
        with provider(config) as worker:
            space=key([REVISION,worker.info]);info=dict(space_id=space,worker=worker.info,retrieval_revision=REVISION)
            with connection(self.path) as db:
                db.execute("insert into semantic_meta values('active_space',?) on conflict(key) do update set payload=excluded.payload",(encode(info),))
                rows=db.execute('''select s.payload,coalesce(v.state,'pending') state from semantic_segments s
                    left join semantic_vectors v on v.segment_id=s.id and v.space_id=?
                    join documents d on d.doc_id=s.doc_id and d.sha256=s.sha256 and d.parser_revision=s.reader
                    where s.active=1 and (v.state is null or (? and v.state='failed'))
                    and (? is null or s.doc_id in (select value from json_each(?)))
                    order by s.doc_id,s.id limit ?''',
                    (space,bool(retry_failed),encode(doc_ids) if doc_ids else None,encode(doc_ids or []),limit)).fetchall()
                selected=[json.loads(row['payload']) for row in rows]
            # Per-segment commits preserve completed work if a later input/process fails.
            with tempfile.TemporaryDirectory(prefix='uvyazka-embedding-') as folder:
                for item in selected:
                    try:
                        if not self._fresh(item,cache):raise ValueError('Source/view changed; refresh before indexing')
                        image=item['modality']=='image'
                        value=self._render(item,folder) if image else item['body']
                        result=worker.embed([value],image=image)[0]
                        if result['error']:raise ValueError(result['error'])
                        # Hash again after model work; a changed original must not publish a ready vector.
                        if not self._fresh(item,{}):raise ValueError('Source changed while embedding')
                        vector=struct.pack('<'+'e'*len(result['vector']),*result['vector'])
                        state,error='ready',None
                    except WorkerError:raise
                    except (ValueError,OSError) as exc:
                        vector=None;state='failed';error=str(exc)[:1000];errors.append(dict(segment_id=item['segment_id'],error=error))
                    with connection(self.path) as db:
                        db.execute('insert or replace into semantic_vectors values(?,?,?,?,?,?)',
                            (item['segment_id'],space,state,vector,error,now()))
                    processed.append(dict(segment_id=item['segment_id'],state=state,modality=item['modality']))
        return bounded(dict(processed=processed,errors=errors,requested_doc_ids=doc_ids,status=self.status()))

    def _literal(self,query,limit,doc_id=None):
        terms=re.findall(r'\w+',query,re.UNICODE)[:20]
        if not terms:return []
        identifier=bool(re.search(r'\d',query)) and len(query.split())==1
        expression='"'+query.replace('"','""')+'"' if identifier else ' AND '.join('"'+t+'"' for t in terms)
        with connection(self.path,readonly=True) as db:
            rows=db.execute('''select c.doc_id,c.sha256,c.page_number,c.text,d.parser_revision,d.relative_path,p.locator
                from chunk_fts join chunks c on c.chunk_id=chunk_fts.rowid
                join documents d on d.doc_id=c.doc_id and d.sha256=c.sha256
                join pages p on p.doc_id=d.doc_id and p.sha256=d.sha256 and p.parser_revision=d.parser_revision and p.page_number=c.page_number
                where chunk_fts match ? and (? is null or d.doc_id=?) order by bm25(chunk_fts) limit 300''',
                (expression,doc_id,doc_id)).fetchall()
        results=[];seen=set();cache={}
        exact_id=re.compile(r'(?<!\w)'+re.escape(query.strip())+r'(?!\w|[./-]\w)',re.I) if identifier else None
        for row in rows:
            # FTS treats punctuation as separators: do not equate Н-1 with Н 1 or Н-1.1.
            if exact_id and not exact_id.search(row['text']):continue
            item=dict(row);item.update(modality='text',locator=json.loads(item['locator']))
            if not self._fresh(item,cache):continue
            identity=key([item['doc_id'],item['sha256'],item['parser_revision'],item['locator'],item['text']])
            if identity in seen:continue
            seen.add(identity);item.update(segment_id=identity,snippet=item.pop('text')[:1800],retrieval_kind='literal',similarity=None)
            results.append(item)
            if len(results)>=limit:break
        return results

    def search(self,query,mode='hybrid',limit=10,doc_id=None,min_similarity=0.72):
        if not isinstance(query,str) or not 1<=len(query.strip())<=500:raise ValueError('Query must be 1–500 characters')
        if mode not in {'literal','semantic','hybrid'}:raise ValueError('Unknown retrieval mode')
        number(limit,'limit',1,30)
        if isinstance(min_similarity,bool) or not isinstance(min_similarity,(int,float)) or not math.isfinite(min_similarity) or not 0<=min_similarity<=1:
            raise ValueError('min_similarity must be between 0 and 1')
        if doc_id:self.workspace.source_record(self.project_id,doc_id)
        literal=self._literal(query,limit,doc_id)
        reason=None;semantic=[];effective=mode
        identifier=bool(re.search(r'\d',query)) and len(query.split())==1
        if mode!='literal' and identifier:effective='literal';reason='identifier_lookup_uses_exact_terms'
        if effective!='literal':
            try:
                config=configuration(self.workspace.home)
                if not config:raise WorkerError('worker_not_configured')
                status=self.status();active=status['active_space']
                if not active or not status['counts']['ready']:raise WorkerError('index_not_prepared')
                with provider(config,text_only=True) as worker:
                    if key([REVISION,worker.info])!=active['space_id']:raise WorkerError('index_model_changed')
                    prompted='task: search result | query: '+query
                    if len(prompted.encode())>400:raise WorkerError('query_exceeds_runtime_budget')
                    result=worker.embed([prompted])[0]
                    if result['error']:raise WorkerError(result['error'])
                    vector=result['vector']
                scores=[]
                try:import numpy as np
                except ImportError:np=None
                with connection(self.path,readonly=True) as db:
                    cursor=db.execute('''select s.id,v.vector from semantic_segments s join semantic_vectors v on s.id=v.segment_id
                        join documents d on d.doc_id=s.doc_id and d.sha256=s.sha256 and d.parser_revision=s.reader
                        where s.active=1 and v.space_id=? and v.state='ready' and (? is null or s.doc_id=?)''',
                        (active['space_id'],doc_id,doc_id))
                    while rows:=cursor.fetchmany(128):
                        if any(len(r['vector'])!=2*len(vector) for r in rows):raise WorkerError('invalid_stored_vector_shape')
                        if np is not None:
                            matrix=np.frombuffer(b''.join(r['vector'] for r in rows),dtype='<f2').reshape(len(rows),len(vector)).astype('float32')
                            values=matrix@np.asarray(vector,dtype='float32')
                        else:values=[sum(a*b for a,b in zip(struct.unpack('<'+'e'*len(vector),r['vector']),vector)) for r in rows]
                        for r,score in zip(rows,values):
                            if not math.isfinite(float(score)):raise WorkerError('nonfinite_stored_vector')
                            if score>=min_similarity:scores.append((float(score),r['id']))
                    cache={}
                    for score,identifier in sorted(scores,key=lambda p:(-p[0],p[1])):
                        item=json.loads(db.execute('select payload from semantic_segments where id=?',(identifier,)).fetchone()[0])
                        if not self._fresh(item,cache):continue
                        item.update(similarity=round(score,6),snippet=item.pop('text'),retrieval_kind='semantic')
                        item.pop('body',None);semantic.append(item)
                        if len(semantic)>=limit:break
            except (WorkerError,OSError,ValueError) as exc:
                effective='literal';reason=str(exc)[:1000]
        if effective=='literal':results=literal
        elif mode=='semantic':results=semantic
        else:
            # Rank fusion is ordering only, not a probability. Preserve distinct fragments in one file.
            combined={}
            for group,weight in [(literal,2),(semantic,1)]:
                for rank,item in enumerate(group,1):
                    identity=key([item['doc_id'],item['sha256'],item['locator'],item['snippet']])
                    if identity not in combined:combined[identity]={**item,'rank_score':0}
                    combined[identity]['rank_score']+=weight/(20+rank)
            results=sorted(combined.values(),key=lambda x:-x['rank_score'])[:limit]
        return bounded(dict(project_id=self.project_id,requested_mode=mode,effective_mode=effective,fallback_reason=reason,
            results=results,status=self.status(),min_similarity=min_similarity,accepted=False,complete_project_review=False,
            warning='Retrieved fragments are candidates, not verified facts. Source hashes checked for returned results; cached coverage is not a full project review.'))
