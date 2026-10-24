"""Versioned model/human explanations over exact source grids, without a prescribed engineering schema."""
import json
import re

from .core import connection,encode,now
from .document_tables import bounded,number,fingerprint
from .structured_readers import engine

SQL='''
create table if not exists structure_analyses(
 analysis_id text,reader text,revision integer,table_id text,payload text,
 primary key(analysis_id,reader,revision));
create table if not exists structure_analysis_requests(
 request_id text primary key,fingerprint text,payload text);
'''


class StructureAnalysis:
    def __init__(self,workspace,project_id):
        self.workspace,self.project_id=workspace,project_id
        self.path=workspace.db_path(project_id)
        with connection(self.path) as db:db.executescript(SQL)

    def table(self,db,table_id):
        if not isinstance(table_id,str) or len(table_id)>100:raise ValueError('Invalid table_id')
        if not db.execute("select 1 from sqlite_master where name='structure_tables'").fetchone():raise ValueError('Build source structure first')
        row=db.execute('select payload from structure_tables where table_id=?',(table_id,)).fetchone()
        if not row:raise ValueError('Unknown source table in this project')
        return json.loads(row[0])

    def state(self,item,verify_source=False,cache=None):
        cache={} if cache is None else cache
        states={}
        for dependency in item['dependencies']:
            source=dependency['source'];key=(source['doc_id'],source['sha256'],dependency['engine'])
            if key not in cache:
                record,_=self.workspace.source_record(self.project_id,source['doc_id'])
                current=record['sha256']==source['sha256'] and engine(record['extension'])==dependency['engine']
                current=current and record['index_status']!='source_missing'
                freshness=self.workspace.source_state(self.project_id,source['doc_id'],full_hash=True)['status'] if verify_source else 'registered_hash_only'
                cache[key]=dict(current=current and (freshness=='content_hash_matches' if verify_source else True),freshness=freshness)
            states[dependency['table_id']]=cache[key]
        return {**item,'dependencies_state':states,'current_sources':all(s['current'] for s in states.values()),
                'freshness_method':'actual_hash' if verify_source else 'registered_hash_only','accepted':False}

    def save(self,analysis_id,table_id,title,summary,data,reader,request_id,expected_revision=0,
             reason='',related_tables=None,evidence_cells=None):
        number(expected_revision,'expected_revision')
        if not isinstance(analysis_id,str) or not re.fullmatch(r'[\w.-]{1,80}',analysis_id):raise ValueError('Invalid analysis_id')
        if reader not in {'model','human'}:raise ValueError('Reader must be model or human')
        for value,name,limit in [(title,'title',300),(summary,'summary',12000),(request_id,'request_id',128)]:
            if not isinstance(value,str) or not value.strip() or len(value)>limit:raise ValueError('Invalid '+name)
        if not isinstance(reason,str) or len(reason)>4000:raise ValueError('Invalid correction reason')
        if not isinstance(data,dict):raise ValueError('data must be a JSON object; engineering interpretation belongs to the caller')
        related_tables=[] if related_tables is None else related_tables
        evidence_cells=[] if evidence_cells is None else evidence_cells
        if not isinstance(related_tables,list) or len(related_tables)>20:raise ValueError('At most 20 related tables')
        if not isinstance(evidence_cells,list) or len(evidence_cells)>200 or any(not isinstance(c,str) for c in evidence_cells):raise ValueError('At most 200 exact cell_ids')
        request=dict(analysis_id=analysis_id,table_id=table_id,title=title,summary=summary,data=data,reader=reader,
                     expected_revision=expected_revision,reason=reason,related_tables=related_tables,evidence_cells=evidence_cells)
        try:raw=json.dumps(request,ensure_ascii=False,allow_nan=False)
        except (ValueError,TypeError) as exc:raise ValueError('Analysis must contain finite JSON values') from exc
        if len(raw.encode())>128*1024:raise ValueError('Analysis exceeds 128 KiB')
        request=json.loads(raw);data=request['data'];related_tables=request['related_tables'];evidence_cells=request['evidence_cells']
        signature=fingerprint(request)
        with connection(self.path) as db:
            db.execute('begin immediate')
            retry=db.execute('select fingerprint,payload from structure_analysis_requests where request_id=?',(request_id,)).fetchone()
            if retry:
                if retry[0]!=signature:raise ValueError('request_id already used for a different analysis')
                return json.loads(retry[1])
            old=db.execute('select revision,table_id from structure_analyses where analysis_id=? and reader=? order by revision desc limit 1',(analysis_id,reader)).fetchone()
            revision=old['revision'] if old else 0
            if expected_revision!=revision:raise ValueError('Analysis revision conflict; reread before correcting')
            if revision and not reason.strip():raise ValueError('Correction requires a reason')
            cards={table_id:self.table(db,table_id)}
            for link in related_tables:
                if not isinstance(link,dict) or not all(isinstance(link.get(k),str) and link[k].strip() for k in ('table_id','relation','reason')):
                    raise ValueError('Related table needs table_id, relation and reason')
                cards[link['table_id']]=self.table(db,link['table_id'])
            for cid in evidence_cells:
                try:tid,r,c=cid.rsplit(':',2);r=int(r);c=int(c)
                except ValueError as exc:raise ValueError('Invalid cell_id') from exc
                if tid not in cards:raise ValueError('Evidence cell must belong to the main or a related table')
                row=db.execute('select payload from structure_rows where table_id=? and row_number=?',(tid,r)).fetchone()
                if not row or not any(item['cell_id']==cid and item['column']==c for item in json.loads(row[0])):
                    raise ValueError('Unknown evidence cell')
            item=dict(analysis_id=analysis_id,table_id=table_id,title=title,summary=summary,data=data,reader=reader,
                      related_tables=related_tables,evidence_cells=evidence_cells,revision=revision+1,reason=reason,
                      dependencies=[dict(table_id=tid,source=card['source'],engine=card['engine']) for tid,card in cards.items()],
                      interpretation_status='caller_interpretation_not_approved',created_at=now(),accepted=False)
            if not self.state(item,True)['current_sources']:raise ValueError('Source changed; refresh and rebase the interpretation')
            db.execute('insert into structure_analyses values(?,?,?,?,?)',(analysis_id,reader,revision+1,table_id,encode(item)))
            db.execute('insert into structure_analysis_requests values(?,?,?)',(request_id,signature,encode(item)))
            db.execute('insert into events(created_at,kind,payload) values(?,?,?)',(now(),'structure_analysis_saved',encode(dict(analysis_id=analysis_id,reader=reader,revision=revision+1))))
        return item

    def list(self,table_id=None,query='',doc_id=None,offset=0,limit=40,verify_source=False,history=False):
        number(offset,'offset');number(limit,'limit',1,100)
        if not isinstance(query,str) or len(query)>500:raise ValueError('Query exceeds 500 characters')
        where=''' from structure_analyses a where (? or not exists(
            select 1 from structure_analyses newer where newer.analysis_id=a.analysis_id and newer.reader=a.reader and newer.revision>a.revision))
            and (? is null or exists(select 1 from json_each(a.payload,'$.dependencies') d where json_extract(d.value,'$.table_id')=?))
            and (? is null or exists(select 1 from json_each(a.payload,'$.dependencies') d where json_extract(d.value,'$.source.doc_id')=?))
            and instr(casefold(a.analysis_id || ' ' || json_extract(a.payload,'$.title') || ' ' || json_extract(a.payload,'$.summary')),casefold(?))>0'''
        args=(bool(history),table_id,table_id,doc_id,doc_id,query)
        with connection(self.path,readonly=True) as db:
            total=db.execute('select count(*)'+where,args).fetchone()[0]
            rows=[json.loads(r[0]) for r in db.execute('select a.payload'+where+' order by a.analysis_id,a.reader,a.revision desc limit ? offset ?',(*args,limit,offset))]
        cache={};items=[self.state(r,verify_source,cache) for r in rows]
        return bounded(dict(project_id=self.project_id,kind='analyses',items=items,total=total,
                            next_offset=offset+limit if offset+limit<total else None,includes_history=bool(history)))
