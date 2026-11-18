"""Project-scoped immutable calculation/document records and source freshness."""
import json
import re
from pathlib import Path

from .core import connection, digest, encode, now
from .document_tables import bounded, fingerprint, number
from .engineering_calculations import calculate, REVISION

SQL='''
create table if not exists engineering_records(
 kind text not null,item_id text not null,revision integer not null,payload text not null,
 primary key(kind,item_id,revision));
create table if not exists engineering_requests(
 request_id text primary key,fingerprint text not null,payload text not null);
'''
KINDS={'calculation','document','document_check'}


def identifier(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',value):
        raise ValueError('Identifier must contain 1–80 ASCII letters, digits, dots, underscores or hyphens')


class EngineeringWork:
    def __init__(self,workspace,project_id):
        self.workspace,self.project_id=workspace,project_id
        self.path=workspace.db_path(project_id)

    def verify_sources(self,sources):
        if not isinstance(sources,list) or len(sources)>20:
            raise ValueError('Provide up to 20 exact source anchors')
        states=[]
        for source in sources:
            if (not isinstance(source,dict) or not {'doc_id','sha256','reason'}<=source.keys()
                    or set(source)-{'doc_id','sha256','reason','page_number','locator'}):
                raise ValueError('A source needs doc_id, sha256, reason and optional page_number/locator')
            if not isinstance(source['reason'],str) or not 1<=len(source['reason'].strip())<=2000:
                raise ValueError('Explain source use')
            record,_=self.workspace.source_record(self.project_id,source['doc_id'])
            if 'page_number' in source:
                number(source['page_number'],'page_number',1)
                if record['extension']!='.pdf' or (record['page_count'] is not None and source['page_number']>record['page_count']):
                    raise ValueError('Physical PDF page outside source')
            state=self.workspace.source_state(self.project_id,source['doc_id'],full_hash=True)
            current=record['sha256']==source['sha256'] and bool(source['sha256']) and state['status']=='content_hash_matches'
            states.append({'doc_id':source['doc_id'],'sha256':source['sha256'],'current':current,'status':state['status']})
        return states

    def state(self,item):
        states=[]
        for source in item['sources']:
            try:
                states.extend(self.verify_sources([source]))
            except (ValueError,OSError):
                states.append({'doc_id':source.get('doc_id'),'current':False,'status':'unavailable_or_changed'})
        method_current=item['kind']!='calculation' or item['data'].get('method_revision')==REVISION
        result={**item,'source_states':states,'current_sources':all(s['current'] for s in states),
                'method_current':method_current,'accepted':False}
        if item['kind']=='document':
            dependencies=[]
            for ref in item['data'].get('calculation_refs',[]):
                case=self.get('calculation',ref['calculation_id'],ref['revision'])['items'][0]
                latest=self.get('calculation',ref['calculation_id'])['items'][0]
                dependencies.append({**ref,'current':case['current_sources'] and case['method_current']
                                     and latest['revision']==ref['revision']})
            result.update(calculation_states=dependencies,current_calculations=all(d['current'] for d in dependencies))
            artifact=item['data']['generation']
            try:
                result['current_artifact']=digest(Path(artifact['artifact']))==artifact['sha256']
            except OSError:
                result['current_artifact']=False
        elif item['kind']=='document_check' and item['data'].get('document_ref'):
            ref=item['data']['document_ref']
            document=self.get('document',ref['document_id'],ref['revision'])['items'][0]
            latest=self.get('document',ref['document_id'])['items'][0]
            result['current_document']=(document['current_sources'] and document['current_calculations']
                and document['current_artifact'] and latest['revision']==ref['revision']
                and document['data']['generation']['sha256']==ref['sha256'])
        return result

    def get(self,kind,item_id=None,revision=None,offset=0,limit=20):
        if kind not in KINDS:raise ValueError('Unknown engineering work kind')
        number(offset,'offset');number(limit,'limit',1,40)
        if revision is not None:
            number(revision,'revision',1)
            if item_id is None:raise ValueError('A historical revision requires item_id')
        if item_id is not None:identifier(item_id)
        with connection(self.path,readonly=True) as db:
            initialized=db.execute("select 1 from sqlite_master where name='engineering_records'").fetchone()
            if not initialized:rows=[]
            else:
                rows=db.execute('''select payload from engineering_records a where kind=?
                    and (? is null or item_id=?) and
                    ((? is not null and revision=?) or (? is null and revision=(select max(revision)
                    from engineering_records b where b.kind=a.kind and b.item_id=a.item_id)))
                    order by item_id limit ? offset ?''',(kind,item_id,item_id,revision,revision,revision,limit+1,offset)).fetchall()
        items=[self.state(json.loads(row[0])) for row in rows[:limit]]
        if item_id is not None and not items:raise ValueError('Unknown engineering record in selected project')
        if item_id is None:
            items=[{k:v for k,v in item.items() if k!='data'} for item in items]
        return bounded({'project_id':self.project_id,'kind':kind,'items':items,
                        'next_offset':offset+limit if len(rows)>limit else None})

    def save(self,kind,item_id,title,basis,sources,assumptions,data,request_id,expected_revision=0,reason=''):
        if kind not in KINDS:raise ValueError('Unknown engineering work kind')
        identifier(item_id);identifier(request_id);number(expected_revision,'expected_revision')
        for value,label,maximum in [(title,'title',300),(basis,'basis',4000)]:
            if not isinstance(value,str) or not 1<=len(value.strip())<=maximum:raise ValueError('Invalid '+label)
        if (not isinstance(assumptions,list) or len(assumptions)>40
                or any(not isinstance(x,str) or not 1<=len(x.strip())<=2000 for x in assumptions)):
            raise ValueError('Assumptions must be up to 40 explicit nonempty statements')
        if not sources and not assumptions:raise ValueError('Cite source anchors or declare assumptions; do not invent input provenance')
        if not isinstance(data,dict) or len(encode(data))>200000:raise ValueError('Engineering data exceeds bounded record size')
        if not isinstance(reason,str) or len(reason)>4000 or (expected_revision and not reason.strip()):
            raise ValueError('A revision requires an explanation')
        request=dict(kind=kind,item_id=item_id,title=title,basis=basis,sources=sources,assumptions=assumptions,
                     data=data,expected_revision=expected_revision,reason=reason)
        signature=fingerprint(request)
        with connection(self.path) as db:
            db.executescript(SQL);db.execute('begin immediate')
            previous=db.execute('select * from engineering_requests where request_id=?',(request_id,)).fetchone()
            if previous:
                if previous['fingerprint']!=signature:raise ValueError('request_id already used for different work')
                return self.state(json.loads(previous['payload']))
            revision=db.execute('select max(revision) from engineering_records where kind=? and item_id=?',(kind,item_id)).fetchone()[0] or 0
            if revision!=expected_revision:raise ValueError('Engineering revision conflict; reload current record')
            states=self.verify_sources(sources)
            if not all(s['current'] for s in states):raise ValueError('Source changed; refresh and rebase this work')
            item=dict(project_id=self.project_id,kind=kind,item_id=item_id,revision=revision+1,title=title,
                      basis=basis,sources=sources,assumptions=assumptions,data=data,reason=reason,created_at=now(),accepted=False)
            db.execute('insert into engineering_records values(?,?,?,?)',(kind,item_id,revision+1,encode(item)))
            db.execute('insert into engineering_requests values(?,?,?)',(request_id,signature,encode(item)))
            db.execute('insert into events(created_at,kind,payload) values(?,?,?)',
                       (now(),'engineering_work_saved',encode({'kind':kind,'item_id':item_id,'revision':revision+1})))
        return {**item,'source_states':states,'current_sources':True,'method_current':True}

    def run(self,calculation_id,title,method,inputs,basis,sources,assumptions,request_id,
            reported_results=None,criteria=None,expected_revision=0,reason=''):
        data=calculate(method,inputs,reported_results,criteria)
        data.update(inputs=inputs,reported_results=reported_results,criteria=criteria)
        return self.save('calculation',calculation_id,title,basis,sources,assumptions,data,
                         request_id,expected_revision,reason)
