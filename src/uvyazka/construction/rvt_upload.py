"""Loopback UI uploads use the same preparation service as the desktop agent."""
import hashlib
import importlib.util
import json
import os
import re
import threading
from uuid import uuid4,uuid5,NAMESPACE_URL

from ..core import connection,encode,now
from .planning import Planning
from .rvt_data import RvtData
from .rvt_preparation import prepare
from .rvt_runtime import converter_status

MAX_UPLOAD=512*1024*1024


class RvtUploads:
    def __init__(self,workspace):
        self.workspace=workspace;self.token=uuid4().hex;self.session=uuid4().hex
        self.slots=threading.BoundedSemaphore(4);self.worker=threading.Semaphore(1)

    def database(self,project):
        path=self.workspace.db_path(project)
        with connection(path) as db:
            db.execute('create table if not exists rvt_upload_jobs(job_id text primary key,payload text not null)')
            db.execute('create table if not exists uploaded_sources(doc_id text primary key,relative_path text not null)')
        return path

    def runtime(self):
        status=converter_status(self.workspace.home)
        return {'upload_token':self.token,'max_bytes':MAX_UPLOAD,'requires_revit':False,
            'data_ready':status['binaries']['ifccs-rvt-metadata']['available'],
            'geometry_ready':status['available'] and importlib.util.find_spec('ifcopenshell') is not None,
            'compute_location':'this_computer','active_jobs_limit':4}

    def get(self,project,job_id=None):
        path=self.workspace.db_path(project)
        with connection(path,readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where name='rvt_upload_jobs'").fetchone():
                if job_id:raise ValueError('Unknown upload job in this project')
                return {'items':[]}
            rows=db.execute('select payload from rvt_upload_jobs'+(' where job_id=?' if job_id else ' order by rowid desc limit 12'),(job_id,) if job_id else ()).fetchall()
        items=[json.loads(row[0]) for row in rows]
        for item in items:
            if item['session']!=self.session and item['status'] in {'queued','extracting','converting','linking','planning'}:
                item['status']='previous_session'
        if job_id:
            if not items:raise ValueError('Unknown upload job in this project')
            return items[0]
        return {'project_id':project,'items':items}

    def update(self,job,**values):
        job.update(values);job['updated_at']=now()
        with connection(self.database(job['project_id'])) as db:
            db.execute('insert or replace into rvt_upload_jobs values (?,?)',(job['job_id'],encode(job)))

    def receive(self,project,filename,length,stream,simulate=False):
        if not isinstance(filename,str) or len(filename)>180 or re.search(r'[<>:"/\\|?*\x00-\x1f]',filename) or not filename.lower().endswith('.rvt'):
            raise ValueError('Нужно имя файла .rvt без пути и специальных символов')
        if not 8<=length<=MAX_UPLOAD:raise ValueError('Допустим RVT до 512 MiB')
        if not self.slots.acquire(blocking=False):raise ValueError('Очередь заполнена; дождитесь завершения текущих загрузок')
        temporary=None
        try:
            path=self.database(project);parent=path.parent.resolve();root=(parent/'uploads').resolve()
            if not root.is_relative_to(parent):raise ValueError('Invalid upload directory')
            root.mkdir(parents=True,exist_ok=True);temporary=root/(uuid4().hex+'.part')
            remaining=length;sha=hashlib.sha256();first=True
            with temporary.open('xb') as output:
                while remaining:
                    chunk=stream.read(min(1024*1024,remaining))
                    if not chunk:raise ValueError('Загрузка оборвалась до конца файла')
                    if first:
                        if not chunk.startswith(bytes.fromhex('D0CF11E0A1B11AE1')):raise ValueError('Не найден заголовок RVT OLE/CFB')
                        first=False
                    sha.update(chunk);output.write(chunk);remaining-=len(chunk)
            fingerprint=sha.hexdigest();folder=(root/fingerprint).resolve()
            if not folder.is_relative_to(root):raise ValueError('Invalid upload target')
            folder.mkdir(exist_ok=True);target=folder/'source.rvt'
            if target.is_symlink():raise ValueError('Upload target must not be a link')
            os.replace(temporary,target);temporary=None;stat=target.stat()
            doc_id=uuid5(NAMESPACE_URL,project+'/uploaded-rvt/'+fingerprint).hex
            with connection(path) as db:
                db.execute('insert or ignore into documents(doc_id,relative_path,extension,sha256,size_bytes,mtime_ns,page_count,index_status,parser_revision) values (?,?,?,?,?,?,0,?,?)',
                    (doc_id,'Загрузки/'+fingerprint[:12]+'/'+filename,'.rvt',fingerprint,stat.st_size,stat.st_mtime_ns,'uploaded_rvt','native-rvt-upload-v1'))
                db.execute('update documents set size_bytes=?,mtime_ns=? where doc_id=?',(stat.st_size,stat.st_mtime_ns,doc_id))
                db.execute('insert or replace into uploaded_sources values (?,?)',(doc_id,fingerprint+'/source.rvt'))
                db.execute('insert into events(created_at,kind,payload) values (?,?,?)',(now(),'rvt_uploaded',encode({'doc_id':doc_id,'sha256':fingerprint,'filename':filename})))
            job={'project_id':project,'job_id':uuid4().hex,'doc_id':doc_id,'filename':filename,
                'sha256':fingerprint,'created_at':now(),'session':self.session,'status':'queued','simulate':simulate}
            self.update(job)
            threading.Thread(target=self.run,args=(job,),daemon=True,name='uvyazka-rvt-upload').start()
            return dict(job)
        except Exception:
            if temporary is not None and temporary.is_file():temporary.unlink()
            self.slots.release();raise

    def run(self,job):
        try:
            with self.worker:
                result=prepare(self.workspace,job['project_id'],job['doc_id'],'ui-'+job['job_id'],
                    progress=lambda status:self.update(job,status=status))
                simulation=None
                geometry=result['stages']['geometry']
                if job['simulate'] and geometry.get('model_id'):
                    self.update(job,status='planning')
                    try:
                        planning=Planning(self.workspace);scenario='rvt-'+job['job_id'][:20]
                        proposed=planning.suggest_ifc_scenario(job['project_id'],geometry['model_id'],scenario,'ui-plan-'+job['job_id'],phase_selections={'model':'all'})
                        run=planning.run_scenario(job['project_id'],scenario)
                        simulation={'status':'calculated_requires_review','scenario_id':scenario,'run':run,
                            'operation_count':proposed['operation_count'],'phase_mode':'all_without_phase_filter',
                            'interpretation':'Условный сценарий по всей модели без разделения стадий; не утверждённый план строительства'}
                    except (ValueError,OSError) as error:simulation={'status':'failed','error':str(error)[-2500:]}
                self.update(job,status='completed',result=result,simulation=simulation)
        except Exception as error:
            self.update(job,status='failed',error=type(error).__name__+': '+str(error)[-2500:])
        finally:self.slots.release()


def serve_get(handler,uploads,path,query):
    if not path.startswith('/api/rvt/'):return False
    project=query.get('project_id','');uploads.workspace.project(project)
    key=path.rsplit('/',1)[-1]
    if key=='runtime':handler.send(uploads.runtime())
    elif key in {'jobs','job'}:handler.send(uploads.get(project,query.get('job_id') if key=='job' else None))
    elif key in {'data','record'}:
        data=RvtData(uploads.workspace);offset=int(query.get('offset','0'));limit=int(query.get('limit','30'))
        if key=='data':result=data.read(project,query['extraction_id'],query.get('section','elements'),query.get('q',''),offset,limit)
        else:result=data.record(project,query['extraction_id'],int(query['record_id']),query.get('section','fields'),offset,limit,
            json.loads(query['json_path']) if query.get('json_path') else None)
        handler.send(result)
    else:handler.send({'error':'Unknown RVT route'},status=404)
    return True
