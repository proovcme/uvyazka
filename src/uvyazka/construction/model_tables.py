"""Immutable tables computed by the same DOM-free JS engine as the viewer.

Optional embedded V8 executes our fixed bundle only, never user supplied code.
Source snapshots and table definitions remain independently addressable in SQLite.
"""
from __future__ import annotations
import json
import re
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from importlib.resources import files
from uuid import uuid4

from ..core import connection,encode,now,digest
from .simulation import canonical_hash
from .rvt_catalog import RvtCatalog
from .planning import bounded,Planning

SQL=[
 'create table if not exists model_tables(table_id text primary key,payload text not null)',
 'create table if not exists model_table_requests(request_id text primary key,fingerprint text not null,table_id text not null)',
]

def engine_sha():
    import hashlib
    return hashlib.sha256(files('uvyazka').joinpath('resources/table-engine.js').read_bytes()).hexdigest()

def compute(method,payload):
    # FastMCP can call synchronous tools on its event loop. MiniRacer reuses a
    # running loop and then cannot apply synchronous cancellation deadlines.
    # Give each computation its own worker and cancellable V8 context.
    with ThreadPoolExecutor(max_workers=1,thread_name_prefix='uvyazka-tables') as pool:
        return pool.submit(_compute,method,payload).result(timeout=210)

def _compute(method,payload):
    if method not in {'describe','build','render'}:raise ValueError('Unknown table operation')
    try:
        from py_mini_racer import MiniRacer
    except ImportError as exc:
        raise ValueError("Install shared table runtime: pip install 'uvyazka[tables]'") from exc
    # JSON arguments are serialized by MiniRacer.call, never interpolated as JS.
    try:
        with MiniRacer() as context:
            context.set_hard_memory_limit(1024*1024*1024)
            context.eval(files('uvyazka').joinpath('resources/table-engine.js').read_text(encoding='utf-8'),timeout_sec=15)
            return context.call('UvyazkaTables.'+method,payload,timeout_sec=180)
    except Exception as exc:
        # V8 exceptions may include an entire minified bundle as source context.
        # Keep the actual message, never send that source through MCP/UI.
        message=str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        raise ValueError('Table calculation failed: '+message[:600]) from None


class ModelTables:
    def __init__(self,workspace):self.workspace=workspace

    def db(self,project_id):
        path=self.workspace.db_path(project_id)
        with connection(path) as db:
            for statement in SQL:db.execute(statement)
        return path

    def inputs(self,project_id,extraction_id='',model_id=''):
        self.workspace.project(project_id)
        if not extraction_id and not model_id:raise ValueError('Choose a stored catalogue or model')
        documents=[RvtCatalog(self.workspace).document(project_id,extraction_id)] if extraction_id else []
        model=Planning(self.workspace).model(project_id,model_id) if model_id else None
        return {'model':model,'documents':documents,'project_id':project_id}

    def schema(self,project_id,extraction_id='',model_id='',query='',offset=0,limit=40):
        data=compute('describe',self.inputs(project_id,extraction_id,model_id))
        columns=data.pop('columns')
        selected=[c for c in columns if not query or query.casefold() in encode(c).casefold()]
        return {'project_id':project_id,'engine_sha256':engine_sha(),**data,**bounded(selected,offset,limit)}

    def build(self,project_id,request_id,extraction_id='',model_id='',kind='parameters',definition=None,element_id='',options=None):
        if not isinstance(request_id,str) or not 1<=len(request_id)<=128:raise ValueError('request_id: 1–128 characters')
        if kind not in {'parameters','native_schedule','gost'}:raise ValueError('kind: parameters, native_schedule or gost')
        identity={'engine_sha256':engine_sha(),'extraction_id':extraction_id,'model_id':model_id,'kind':kind,'definition':definition,'element_id':element_id,'options':options}
        table_id=canonical_hash(identity)
        path=self.db(project_id)
        def retry(db):
            old=db.execute('select fingerprint,table_id from model_table_requests where request_id=?',(request_id,)).fetchone()
            if old and old['fingerprint']!=table_id:raise ValueError('request_id already used for another table')
            saved=db.execute('select payload from model_tables where table_id=?',(table_id,)).fetchone()
            return json.loads(saved[0]) if saved else None
        with connection(path,readonly=True) as db:stored=retry(db)
        if stored is None:
            result=compute('build',{**self.inputs(project_id,extraction_id,model_id),'kind':kind,'definition':definition,'element_id':element_id,'options':options})
            stored={'project_id':project_id,'table_id':table_id,'created_at':now(),**identity,**result}
        with connection(path) as db:
            db.execute('begin immediate')
            existing=retry(db)
            if existing:stored=existing
            else:
                db.execute('insert into model_tables values (?,?)',(table_id,encode(stored)))
                db.execute('insert into events(created_at,kind,payload) values (?,?,?)',(now(),'model_table_built',encode(self.summary(stored))))
            db.execute('insert or ignore into model_table_requests values (?,?,?)',(request_id,table_id,table_id))
        return self.summary(stored)

    @staticmethod
    def summary(stored):
        report=stored['report']
        return {k:v for k,v in stored.items() if k not in {'report','definition','options'}}|{'coverage':report.get('coverage'),'row_count':len(report.get('rows',[])),'issue_count':len(report.get('issues',[])),'release_ready':report.get('release_ready',False),'value_semantics':'saved_values_not_revit_evaluation'}

    def stored(self,project_id,table_id):
        if not re.fullmatch('[0-9a-f]{64}',table_id):raise ValueError('Invalid table_id')
        with connection(self.db(project_id),readonly=True) as db:row=db.execute('select payload from model_tables where table_id=?',(table_id,)).fetchone()
        if not row:raise ValueError('Table not found in this project')
        return json.loads(row[0])

    def read(self,project_id,table_id,section='rows',offset=0,limit=40,json_path=None,max_chars=6000):
        stored=self.stored(project_id,table_id);report=stored['report']
        if section=='summary':
            totals=[]
            for i,item in enumerate(report.get('totals',[])):
                cell=item.get('cell',{})
                totals.append({**{k:v for k,v in item.items() if k!='cell'},'cell':{k:v for k,v in cell.items() if k!='evidence'},
                    'evidence_count':len(cell.get('evidence',[])),'json_path':['totals',i]})
            return {**self.summary(stored),'definition':report.get('definition'),'totals':totals}
        if section=='value':
            from ..model_data import at
            if type(max_chars) is not int or not 100<=max_chars<=20000 or type(offset) is not int or offset<0:raise ValueError('Bounded character range required')
            text=encode(at(report,json_path or []));end=offset+max_chars
            return {'table_id':table_id,'json_path':json_path or [],'json_text':text[offset:end],'total_chars':len(text),'next_offset':end if end<len(text) else None}
        if section not in {'rows','selection','issues','columns'}:raise ValueError('section: summary, rows, selection, issues, columns or value')
        rows=report.get('definition',{}).get('columns',report.get('columns',[])) if section=='columns' else report.get(section,[])
        # Bound response bytes as well as row count: large groups retain exact
        # evidence in section=value and exports, never claim complete preview.
        page=bounded(rows,offset,limit)
        rendered=[];used=0
        for index,row in enumerate(page['items']):
            text=encode(row)
            if len(text)>12000:
                row={'preview_truncated':True,'json_path':[section,offset+index],'total_chars':len(text),'read_tool':'read_model_table section=value'}
            size=len(encode(row))
            if rendered and used+size>50000:break
            rendered.append(row);used+=size
        page['items']=rendered;page['next_offset']=offset+len(rendered) if offset+len(rendered)<len(rows) else None
        return {'table_id':table_id,'section':section,**page}

    def export(self,project_id,table_id,format='json'):
        stored=self.stored(project_id,table_id)
        if format not in {'json','csv','xlsx'}:raise ValueError('format: json, csv or xlsx')
        # Export with the exact engine revision that produced the immutable table.
        if stored['engine_sha256']!=engine_sha():raise ValueError('Table engine changed; rebuild with a new request_id before formatted export')
        value=compute('render',{'kind':stored['kind'],'report':stored['report'],'format':format})
        folder=self.workspace.db_path(project_id).parent/'model-table-exports'/table_id;folder.mkdir(parents=True,exist_ok=True)
        target=folder/(uuid4().hex+'.'+format)
        if isinstance(value,list):target.write_bytes(bytes(value))
        else:target.write_text(value,encoding='utf-8')
        manifest={**self.summary(stored),'artifact':str(target),'artifact_sha256':digest(target),'format':format}
        Path(str(target)+'.source.json').write_text(encode(manifest),encoding='utf-8')
        return manifest


def register_tools(mcp,workspace):
    tables=ModelTables(workspace);read={'readOnlyHint':True,'idempotentHint':True};write={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True}

    @mcp.tool(annotations=write)
    async def prepare_model_tables(project_id:str,doc_id:str,request_id:str)->dict:
        """Read registered RVT parameters/types and schedule definitions directly into one immutable shared catalogue. No viewer export, IFC or Revit needed. Uses the same compact native projection as the browser, retains source SHA, worksets and shared definitions. Returns extraction_id for get_model_table_schema/build_model_table; saved values are not evaluated Revit rows. Requires native runtime."""
        return await asyncio.to_thread(RvtCatalog(workspace).prepare,project_id,doc_id,request_id)

    @mcp.tool(annotations=read)
    async def get_model_table_schema(project_id:str,extraction_id:str='',model_id:str='',query:str='',offset:int=0,limit:int=40)->dict:
        """List exact table field IDs and default definition from a stored RVT catalogue and/or registered scene (IFC/RVT/Navisworks). Same calculation code as GUI; continue pages. Pass exact IDs, source hashes and model_id in definition. No guessing units/category captions when not read. GOST proposal is unconfirmed."""
        return await asyncio.to_thread(tables.schema,project_id,extraction_id,model_id,query,offset,limit)

    @mcp.tool(annotations=write)
    async def build_model_table(project_id:str,request_id:str,extraction_id:str='',model_id:str='',kind:str='parameters',definition:dict|None=None,element_id:str='',options:dict|None=None)->dict:
        """Build and save an immutable table with the same filters/grouping/totals as GUI. kind=parameters (definition from schema); native_schedule (exact Revit element_id, saved filters); gost (explicit confirmed bindings in definition.gost, XLSX available). No guessed formulas/phases/linked model evaluation. Unknown selection stays separate. Scene scopes require a registered model; no mesh-free geometry inference. Returns table_id; read/export with next tools."""
        return await asyncio.to_thread(tables.build,project_id,request_id,extraction_id,model_id,kind,definition,element_id,options)

    @mcp.tool(annotations=read)
    def read_model_table(project_id:str,table_id:str,section:str='rows',offset:int=0,limit:int=40,json_path:list[str|int]|None=None,max_chars:int=6000)->dict:
        """Read a saved table: rows, columns, selection, issues, summary or value. Row previews are bounded; section=value with json_path and character continuation preserves exact cells, units and source evidence. Tables remain drafts unless explicitly release_ready. Shared project database, no rereading RVT."""
        return tables.read(project_id,table_id,section,offset,limit,json_path,max_chars)

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':False})
    async def export_model_table(project_id:str,table_id:str,format:str='json')->dict:
        """Export saved table with provenance manifest: JSON (all), CSV (parameters/native_schedule), XLSX (GOST). Uses same GUI export code; CSV protects formula-like text. Exports are new local artifacts, original models stay read-only. GOST source/question sheets preserve unresolved data."""
        return await asyncio.to_thread(tables.export,project_id,table_id,format)
