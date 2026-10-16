"""Cached native RVT records, saved views and schedule definitions/cells."""
from __future__ import annotations
import csv
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
from uuid import uuid4

from ..core import connection, digest, encode, now
from .planning import Planning, bounded
from .rvt_runtime import binary_path, sha256
from .simulation import canonical_hash

VERSION = '0.1.0'
SQL = [
    'create table if not exists rvt_extractions(extraction_id text primary key,payload text not null)',
    'create table if not exists rvt_native_records(extraction_id text,record_id integer,element_id text,class_name text,kind text,name text,status text,payload text,primary key(extraction_id,record_id))',
    'create table if not exists rvt_data_requests(request_id text primary key,fingerprint text,payload text)',
]


def ancestry(name, classes):
    result=[]
    while name and name not in result:
        result.append(name);name=classes.get(name,{}).get('parent')
    return result


def kind_for(name, classes):
    chain=ancestry(name,classes)
    if 'TableView' in chain: return 'schedule'
    if 'DBView' in chain: return 'view'
    if set(chain)&{'Viewport','ScheduleInstanceBase'}: return 'placement'
    return 'element'


def objects(record):
    return (record.get('graph') or {}).get('objects',[])


def linked(record,index,value):
    """Resolve only explicit graph edges at the pointer's serialized offset."""
    if not isinstance(value,dict) or value.get('pointer_token')==0:return None
    for edge in (record.get('graph') or {}).get('edges',[]):
        if edge['source_object_index']==index and edge['pointer_offset']==value.get('offset'):
            target=edge['target_object_index']
            if 0<=target<len(objects(record)): return target
    return None


def identifier(value):
    if type(value) is int:return str(value)
    if isinstance(value,dict):
        for key in ['m_id64','m_id']:
            if key in value:return identifier(value[key])
    return None


def pointer_row(record,index,key,value,**extra):
    path=['graph','objects',index,'fields',key]
    return {'json_path':path,'field':key,'raw_value':value,**extra}


def project_record(record,section):
    graph=objects(record)
    if section=='fields':
        return [pointer_row(record,0,k,v) for k,v in (graph[0]['fields'] if graph else {}).items()]
    if section=='graph':
        return [{'json_path':['graph','objects',i],**row} for i,row in enumerate(graph)]
    if section=='parameters':
        rows=[];metadata=record.get('saved_metadata') or {}
        for index,part in enumerate(metadata.get('parameter_sets',[])):
            for j,param in enumerate(part.get('parameters',[])):
                rows.append({**param,'source_object':part.get('source_object'),'json_path':['saved_metadata','parameter_sets',index,'parameters',j]})
        for key in ['raw_field_parameters','resolved_family_parameters','family_parameter_slots','declared_custom_parameters','parameter_definitions','builtin_parameter_definitions']:
            rows.extend({**p,'projection':key,'json_path':['saved_metadata',key,i]} for i,p in enumerate(metadata.get(key,[])))
        return rows
    if section=='view':
        if not graph:return []
        # These names are stored in the native DBView schema. Raw enum codes,
        # coordinates and units are intentionally not guessed from API enums.
        selected={'m_viewName','m_viewDescription','m_scale','m_strCustomScaleName','m_isTemplate',
            'm_viewTemplateId','m_defaultTemplateId','m_dbDrawingId','m_dbViewTypeId',
            'm_primaryViewId','m_dependentViewIds','m_sheetViewportElemId','m_origin',
            'm_viewDir','m_horzDir','m_vertDir','m_explicitlyHiddenElements',
            'm_cutPlaneElev','m_topClipElev','m_bottomClipElev','m_planViewType',
            'm_sectionViewType','m_pCutter','m_pPlanViewRange','m_pPlanViewRange2',
            'm_detailNumber','m_dbViewId','m_labelOrigin','m_offset','m_attrId',
            'm_scheduleId','m_internalScheduleId','origin_XYZ','rotationValue'}
        return [pointer_row(record,0,k,v) for k,v in graph[0]['fields'].items() if k in selected]
    if section=='schedule_definition':
        if not graph:return []
        schema=linked(record,0,graph[0]['fields'].get('m_pSchema'))
        if schema is None or graph[schema]['class_name']!='ScheduleSchema':return []
        result=[]
        for key,value in graph[schema]['fields'].items():
            row=pointer_row(record,schema,key,value)
            # Expose explicit targets of filters, sorting and embedded schema.
            # No field-name or spatial matching is used to infer a connection.
            if key in {'m_filterArr','m_sortFieldArr','m_pEmbeddedSchema'}:
                targets=[]
                for pointer in value if isinstance(value,list) else [value]:
                    target=linked(record,schema,pointer)
                    if target is not None:targets.append({'class_name':graph[target]['class_name'],
                        'properties':graph[target]['fields'],'json_path':['graph','objects',target,'fields']})
                row['resolved_targets']=targets
            result.append(row)
        return result
    if section=='schedule_fields':
        if not graph:return []
        schema=linked(record,0,graph[0]['fields'].get('m_pSchema'))
        if schema is None or graph[schema]['class_name']!='ScheduleSchema':return []
        fields=graph[schema]['fields'];pointers=fields.get('m_pFields',[]);ids=fields.get('m_fieldIds',[])
        result=[]
        for i,pointer in enumerate(pointers):
            target=linked(record,schema,pointer)
            if target is None or graph[target]['class_name']!='ScheduleField':continue
            result.append({'field_id':identifier(ids[i]) if len(ids)==len(pointers) else None,
                'saved_order':i,'properties':graph[target]['fields'],'json_path':['graph','objects',target,'fields']})
        return result
    if section=='schedule_cells':
        if not graph:return []
        data=linked(record,0,graph[0]['fields'].get('m_pData'))
        if data is None or graph[data]['class_name'] not in {'ScheduleData','PanelScheduleData','MEPSystemScheduleData'}:return []
        result=[]
        for pointer in graph[data]['fields'].get('m_SectionData',[]):
            section_index=linked(record,data,pointer)
            if section_index is None:continue
            fields=graph[section_index]['fields']
            for row in fields.get('m_tableCells',[]):
                row_index=linked(record,section_index,row) if isinstance(row,dict) else None
                nested=row_index is not None and graph[row_index]['class_name']=='TableRowCellData'
                cells=graph[row_index]['fields'].get('m_arrCells',[]) if nested else row if isinstance(row,list) else [row]
                for cell in cells:
                    target=linked(record,row_index if nested else section_index,cell)
                    if target is None or graph[target]['class_name']!='TableCellData':continue
                    result.append({'section_index':fields.get('m_index'),'properties':graph[target]['fields'],
                        'json_path':['graph','objects',target,'fields'],'value_semantics':'saved_cell_not_evaluated_body'})
        return result
    raise ValueError('section: fields, parameters, view, graph, schedule_definition, schedule_fields, schedule_cells or value')


def preview_page(rows,offset=0,limit=40):
    offset=max(0,int(offset));page=bounded(rows,offset,limit);result=[];budget=0
    for row in page['items']:
        raw=encode(row)
        shown=row if len(raw)<=2500 else {'json_path':row.get('json_path'), 'truncated':True,
            'json_preview':raw[:1800],'note':'Use section=value and json_path to read the complete JSON with continuation'}
        size=len(encode(shown))
        if result and budget+size>20000:break
        result.append(shown);budget+=size
    return {**page,'items':result,'next_offset':offset+len(result) if offset+len(result)<len(rows) else None}


def json_fragment(value,json_path=None,offset=0,max_chars=6000):
    for key in json_path or []:
        if isinstance(value,dict) and isinstance(key,str) and key in value:value=value[key]
        elif isinstance(value,list) and type(key) is int and 0<=key<len(value):value=value[key]
        else:raise ValueError('JSON path does not exist')
    text=encode(value);offset=max(0,int(offset));end=min(len(text),offset+min(max(1,max_chars),10000))
    return {'json_path':json_path or [],'json_text':text[offset:end],'offset':offset,
        'next_offset':end if end<len(text) else None,'total_chars':len(text)}


class RvtData:
    def __init__(self,workspace):self.workspace=workspace

    def db(self,project_id):
        path=self.workspace.db_path(project_id)
        with connection(path) as db:
            for statement in SQL:db.execute(statement)
        return path

    def extract(self,project_id,doc_id,request_id,profile='all'):
        if profile not in {'all','views','schedules'}:raise ValueError('profile: all, views or schedules')
        if not request_id or len(request_id)>128:raise ValueError('request_id: 1–128 characters')
        document,source=self.workspace.source_record(project_id,doc_id)
        if source.suffix.lower()!='.rvt' or not 0<source.stat().st_size<=512*1024*1024:raise ValueError('Choose a registered RVT <=512 MiB')
        with source.open('rb') as stream:
            if stream.read(8)!=bytes.fromhex('D0CF11E0A1B11AE1'):raise ValueError('RVT OLE/CFB signature missing')
        pointer={'doc_id':doc_id,'sha256':document['sha256'] or digest(source),'locator':'Saved native RVT data'}
        p=Planning(self.workspace);p.validate_sources(project_id,[pointer])
        binary=binary_path('ifccs-rvt-metadata')
        if not binary.is_file():raise ValueError('Build the RVT runtime: uv run python tools/setup_rvt.py')
        reader_hash=sha256(binary)
        fingerprint=canonical_hash([doc_id,pointer['sha256'],reader_hash,profile,VERSION])
        path=self.db(project_id)
        with connection(path,readonly=True) as db:
            previous=db.execute('select * from rvt_data_requests where request_id=?',(request_id,)).fetchone()
            if previous:
                if previous['fingerprint']!=fingerprint:raise ValueError('request_id already used for different RVT data')
                return json.loads(previous['payload'])
            cached=db.execute('select payload from rvt_extractions where extraction_id=?',(fingerprint,)).fetchone()
        if cached:
            result=json.loads(cached[0])
            with connection(path) as db:db.execute('insert into rvt_data_requests values (?,?,?)',(request_id,fingerprint,encode(result)))
            return result
        folder=path.parent/'rvt-data'/uuid4().hex;folder.mkdir(parents=True)
        copied=folder/'source.rvt';shutil.copyfile(source,copied)
        if digest(copied)!=pointer['sha256']:raise ValueError('RVT changed while making the working copy')
        request=folder/'request.json';inventory_path=folder/'inventory.json'
        request.write_text(encode({'mode':'inventory'}),encoding='utf-8')
        self.invoke(binary,copied,request,inventory_path)
        inventory=json.loads(inventory_path.read_text(encoding='utf-8'))
        classes={c['name']:c for c in inventory['classes']}
        selected=[] if profile=='all' else [name for name in classes if kind_for(name,classes) in ({'view','schedule','placement'} if profile=='views' else {'schedule'})]
        output=folder/'records.ndjson';summary_path=folder/'records.summary.json'
        if profile!='all' and not selected:
            output.write_text('',encoding='utf-8');summary_path.write_text(encode({'status':'unsupported_profile','record_count':0,'error':'Requested class roots not found; absence of records is not established'}),encoding='utf-8')
        else:
            request.write_text(encode({'mode':'records','classes':selected,'max_records':20000}),encoding='utf-8')
            self.invoke(binary,copied,request,output)
        report=json.loads(summary_path.read_text(encoding='utf-8'))
        p.validate_sources(project_id,[pointer])
        if sha256(binary)!=reader_hash:raise ValueError('Native reader changed during extraction')
        counts={};records=[]
        with output.open(encoding='utf-8') as stream:
            for index,line in enumerate(stream):
                if len(line)>3*1024*1024:raise ValueError('Native record exceeds the cache budget')
                row=json.loads(line);kind=kind_for(row.get('class_name'),classes);counts[kind]=counts.get(kind,0)+1
                graph=objects(row);fields=graph[0]['fields'] if graph else {}
                name=fields.get('m_viewName') or fields.get('m_name') or ''
                if not isinstance(name,str):name=''
                status=row.get('projection_status') or ('partial_metadata' if row.get('metadata_diagnostic') else row['status'])
                records.append((fingerprint,index,str(row['identity']['element_id']),row.get('class_name'),kind,name,status,encode(row)))
        result={'project_id':project_id,'extraction_id':fingerprint,'profile':profile,'source':pointer,'created_at':now(),
            'reader_version':VERSION,'reader_sha256':reader_hash,'status':report['status'],'counts':counts,
            'record_count':len(records),'error':report.get('error'),'value_semantics':'serialized_not_evaluated',
            'classes_file':str(inventory_path),'summary_file':str(summary_path),
            'requires_revit':False,
            'schedule_body_status':'Saved definitions/cells only; evaluated body rows/totals are not reconstructed by this reader',
            'view_render_status':'Native view settings are extracted; formatted drawing rendering is not implemented'}
        with connection(path) as db:
            db.execute('begin immediate')
            db.execute('insert into rvt_extractions values (?,?)',(fingerprint,encode(result)))
            db.executemany('insert into rvt_native_records values (?,?,?,?,?,?,?,?)',records)
            db.execute('insert into rvt_data_requests values (?,?,?)',(request_id,fingerprint,encode(result)))
            db.execute('insert into events(created_at,kind,payload) values (?,?,?)',(now(),'rvt_data_extracted',encode(result)))
        return result

    @staticmethod
    def invoke(binary,source,request,output):
        process=subprocess.run([str(binary),'--extract',str(source),str(request),str(output)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=900)
        if process.returncode or not output.is_file():raise ValueError('Native RVT extraction failed; rebuild the runtime if outdated: '+process.stderr[-1800:])

    def snapshot(self,project_id,extraction_id):
        if not re.fullmatch('[0-9a-f]{64}',extraction_id):raise ValueError('Invalid extraction_id')
        with connection(self.workspace.db_path(project_id),readonly=True) as db:
            try:row=db.execute('select payload from rvt_extractions where extraction_id=?',(extraction_id,)).fetchone()
            except sqlite3.OperationalError as error:raise ValueError('No RVT extraction in this project') from error
        if not row:raise ValueError('RVT extraction not found in this project')
        return json.loads(row[0])

    def read(self,project_id,extraction_id,section='elements',query='',offset=0,limit=40,json_path=None,max_chars=6000):
        snapshot=self.snapshot(project_id,extraction_id)
        scope={'project_id':project_id,'extraction_id':extraction_id,'source':snapshot['source'],'snapshot_status':snapshot['status']}
        if section=='summary':return snapshot
        if section in {'coverage','units','parameter_definitions','value'}:
            report=json.loads(Path(snapshot['summary_file']).read_text(encoding='utf-8'))
            if section=='value':return {**scope,**json_fragment(report,json_path,offset,max_chars)}
            key={'coverage':'classes','units':'unit_formats','parameter_definitions':'parameter_definitions'}[section]
            entries=(report.get('summary') or {}).get(key) or {}
            rows=[{'key':k,'properties':v,'json_path':['summary',key,k]} for k,v in entries.items() if query.casefold() in (k+' '+encode(v)).casefold()]
            return {**scope,'section':section,**preview_page(rows,offset,limit)}
        if section=='classes':
            rows=json.loads(Path(snapshot['classes_file']).read_text(encoding='utf-8'))['classes']
            return {**scope,**preview_page([{'name':r['name'],'parent':r['parent'],'field_count':len(r['fields'])} for r in rows if query.casefold() in r['name'].casefold()],offset,limit)}
        if section not in {'elements','views','schedules','placements','diagnostics'}:raise ValueError('Unknown RVT data section')
        with connection(self.workspace.db_path(project_id),readonly=True) as db:
            rows=[dict(r) for r in db.execute('select record_id,element_id,class_name,kind,name,status from rvt_native_records where extraction_id=? order by record_id',(extraction_id,))]
        kinds={'views':'view','schedules':'schedule','placements':'placement'}
        if section in kinds:rows=[r for r in rows if r['kind']==kinds[section]]
        if section=='diagnostics':rows=[r for r in rows if r['status']!='complete_bounded_graph']
        rows=[r for r in rows if query.casefold() in encode(r).casefold()]
        return {**scope,'section':section,**preview_page(rows,offset,limit)}

    def record(self,project_id,extraction_id,record_id,section='fields',offset=0,limit=40,json_path=None,max_chars=6000):
        snapshot=self.snapshot(project_id,extraction_id)
        with connection(self.workspace.db_path(project_id),readonly=True) as db:
            row=db.execute('select payload from rvt_native_records where extraction_id=? and record_id=?',(extraction_id,record_id)).fetchone()
        if not row:raise ValueError('Record not found in this extraction')
        record=json.loads(row[0]);scope={'project_id':project_id,'extraction_id':extraction_id,'record_id':record_id,
            'source':snapshot['source'],'native_source':record['source'],'identity':record['identity'],
            'status':record.get('projection_status') or ('partial_metadata' if record.get('metadata_diagnostic') else record['status']),
            'value_semantics':'serialized_not_evaluated','evaluated_schedule_body_available':False}
        if section=='value':
            return {**scope,**json_fragment(record,json_path,offset,max_chars)}
        return {**scope,'section':section,**preview_page(project_record(record,section),offset,limit)}

    def export_record(self,project_id,extraction_id,record_id,format='json'):
        """Export a cached record; CSV is a long table of saved cells, not an evaluated schedule."""
        if format not in {'json','csv'}:raise ValueError('format: json or csv')
        snapshot=self.snapshot(project_id,extraction_id)
        with connection(self.workspace.db_path(project_id),readonly=True) as db:
            row=db.execute('select payload,kind from rvt_native_records where extraction_id=? and record_id=?',(extraction_id,record_id)).fetchone()
        if not row:raise ValueError('Record not found in this extraction')
        record=json.loads(row['payload']);folder=self.workspace.db_path(project_id).parent/'rvt-exports'/extraction_id
        folder.mkdir(parents=True,exist_ok=True)
        # Each export is a new artifact. Concurrent calls cannot overwrite a prior file.
        target=folder/(str(int(record_id))+'-'+uuid4().hex+'.'+format)
        manifest={'schema_version':1,'project_id':project_id,'extraction_id':extraction_id,'record_id':record_id,
            'source':snapshot['source'],'native_source':record['source'],'identity':record['identity'],
            'value_semantics':'serialized_not_evaluated','evaluated_schedule_body_available':False,
            'requires_revit':False}
        if format=='json':
            target.write_text(encode({**manifest,'record':record}),encoding='utf-8')
            rows=1
        else:
            if row['kind']!='schedule':raise ValueError('CSV export is supported for saved schedule cells only')
            cells=project_record(record,'schedule_cells')
            with target.open('w',encoding='utf-8-sig',newline='') as stream:
                writer=csv.writer(stream);writer.writerow(['section','row','column','has_saved_text','saved_text_json','parameter_id_json','has_calculated_value','calculated_value_json','json_path'])
                for cell in cells:
                    fields=cell['properties']
                    # JSON text keeps absent/null/empty/zero distinct and prevents
                    # interpreting a saved string as a spreadsheet formula.
                    writer.writerow([cell['section_index'],fields.get('m_row'),fields.get('m_column'),'m_text' in fields,
                        encode(fields.get('m_text')),encode(fields.get('m_paramId')),
                        'm_oCalculatedValue' in fields,encode(fields.get('m_oCalculatedValue')),encode(cell['json_path'])])
            rows=len(cells)
        manifest.update({'artifact':str(target),'artifact_sha256':digest(target),'format':format,'row_count':rows,
            'csv_layout':'one_saved_cell_per_row' if format=='csv' else None})
        target.with_suffix(target.suffix+'.source.json').write_text(encode(manifest),encoding='utf-8')
        return manifest
