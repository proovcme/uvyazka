"""Persistent native collision jobs with cancellation and observable work counters."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import time
from uuid import uuid4

from ..core import encode, now
from .clashes import hashed, validate_rule, run_clashes
from .coordination_store import CoordinationStore

POOL=ThreadPoolExecutor(max_workers=2,thread_name_prefix='uvyazka-clash')


class ClashJobs:
    def __init__(self,workspace):self.workspace=workspace;self.store=CoordinationStore(workspace)

    def start(self,project,scene_id,rule,request_id):
        validate_rule(rule)
        if not isinstance(request_id,str) or not 1<=len(request_id)<=128:raise ValueError('Request ID required')
        # Check registration before creating a job; never take a file path from MCP.
        self.store.scene_folder(project,scene_id)
        job_id=hashed([scene_id,rule,request_id])[:32]
        owner=uuid4().hex
        with self.store.db(project) as db:
            db.execute('begin immediate')
            old=db.execute('select job_id from clash_jobs where job_id=?',(job_id,)).fetchone()
            if not old:
                active=db.execute("select count(*) from clash_jobs where status in ('queued','running') and heartbeat>?",(datetime.fromtimestamp(time.time()-180,timezone.utc).isoformat(),)).fetchone()[0]
                if active>=4:raise ValueError('Four jobs already active for this project')
                db.execute('insert into clash_jobs(job_id,scene_id,rule,status,owner,heartbeat) values(?,?,?,?,?,?)',(job_id,scene_id,encode(rule),'queued',owner,now()))
        if not old:POOL.submit(self._run,project,job_id,owner)
        return self.get(project,job_id)

    def get(self,project,job_id):
        with self.store.db(project) as db:row=db.execute('select * from clash_jobs where job_id=?',(job_id,)).fetchone()
        if not row:raise ValueError('Collision job not found in project')
        result={'job_id':job_id,'scene_id':row['scene_id'],'status':row['status'],'heartbeat':row['heartbeat'],'cancel_requested':bool(row['cancel']),'error':row['error'],'report':json.loads(row['report']) if row['report'] else None}
        if row['status'] in {'queued','running'} and (datetime.now(timezone.utc)-datetime.fromisoformat(row['heartbeat'])).total_seconds()>180:
            result['activity']='heartbeat_expired; worker may have stopped; partial report is not a complete check'
        return result

    def list(self,project,limit=30):
        if type(limit) is not int or not 1<=limit<=100:raise ValueError('Invalid job limit')
        with self.store.db(project) as db:rows=db.execute('select job_id,status,scene_id,heartbeat from clash_jobs order by heartbeat desc limit ?',(limit,)).fetchall()
        return {'items':[dict(r) for r in rows]}

    def cancel(self,project,job_id):
        self.get(project,job_id)
        with self.store.db(project) as db:db.execute('update clash_jobs set cancel=1 where job_id=?',(job_id,))
        return self.get(project,job_id)

    def _run(self,project,job_id,owner):
        last=[0.];last_cancel=[0.,False]
        def progress(report,force=False):
            if not force and time.monotonic()-last[0]<.5:return
            last[0]=time.monotonic()
            with self.store.db(project) as db:db.execute('update clash_jobs set report=?,heartbeat=? where job_id=? and owner=?',(encode(report),now(),job_id,owner))
        def cancelled():
            if time.monotonic()-last_cancel[0]>.5:
                last_cancel[0]=time.monotonic()
                with self.store.db(project) as db:row=db.execute('select cancel,owner from clash_jobs where job_id=?',(job_id,)).fetchone()
                last_cancel[1]=not row or row['owner']!=owner or bool(row['cancel'])
            return last_cancel[1]
        try:
            job=self.get(project,job_id)
            with self.store.db(project) as db:db.execute("update clash_jobs set status='running',heartbeat=? where job_id=? and owner=?",(now(),job_id,owner))
            model,binary=self.store.scene(project,job['scene_id'])
            with self.store.db(project) as db:rule=json.loads(db.execute('select rule from clash_jobs where job_id=?',(job_id,)).fetchone()[0])
            report=run_clashes(model,binary,rule,progress,cancelled);report.update(job_id=job_id,scene_id=job['scene_id'])
            progress(report,True)
            self.store.save(project,'clash_run',job_id,report,0,'clash-run-'+job_id)
            with self.store.db(project) as db:db.execute('update clash_jobs set status=?,heartbeat=? where job_id=? and owner=?',(report['status'],now(),job_id,owner))
        except Exception as ex:
            with self.store.db(project) as db:db.execute("update clash_jobs set status='failed',error=?,heartbeat=? where job_id=? and owner=?",(str(ex)[:2000],now(),job_id,owner))


def compare_runs(before,after,lineage_confirmed=False):
    """Missing results are resolved only after complete, comparable checks."""
    if before.get('engine')!=after.get('engine'):return {'comparable':False,'reason':'Geometry engine changed; repeat the baseline before comparing','items':[]}
    if before['rule_hash']!=after['rule_hash']:return {'comparable':False,'reason':'Rule changed; review mapping before comparing','items':[]}
    same=before['source_sha256']==after['source_sha256'] and before['geometry_sha256']==after['geometry_sha256']
    def key(issue):
        refs=[]
        for e in (issue['a'],issue['b']):
            stable=e.get('unique_id') or e.get('ifc_guid')
            if same:stable=e['id']
            if not stable:return None
            refs.append(str(e.get('source_instance_id') or '')+':'+stable)
        return tuple(sorted(refs))
    if not same and not lineage_confirmed:return {'comparable':False,'reason':'Confirm source lineage and unchanged placement before comparing revisions','items':[]}
    maps=[]
    for report in (before,after):
        d={}
        for i in report['issues']:
            k=key(i)
            if k is None or k in d:return {'comparable':False,'reason':'Missing or ambiguous stable object IDs','items':[]}
            d[k]=i
        maps.append(d)
    a,b=maps
    return {'comparable':True,'items':[{'before':a.get(k,{}).get('id'),'after':b.get(k,{}).get('id'),
        'status':'retained' if k in a and k in b else 'new' if k in b else 'not_detected_requires_review' if after.get('complete') else 'question'} for k in sorted(a.keys()|b.keys())],
        'interpretation':'Missing in the later selected scope is not automatic engineering resolution; confirm the object mapping and closure explicitly.'}
