"""MCP access to the same coordination objects, jobs and exports as the GUI."""
import hashlib
from .coordination_store import CoordinationStore
from .clash_jobs import ClashJobs,compare_runs
from .clash_export import bcf,xlsx


def report_with_decisions(store,project,run_id):
    report=store.get(project,'clash_run',run_id)['payload']
    views={}
    for issue in report['issues']:
        try:decision=store.get(project,'issue',issue['id'])['payload']
        except ValueError:continue
        if decision.get('source_sha256')!=report['source_sha256'] or decision.get('geometry_sha256')!=report['geometry_sha256']:
            issue['status']='stale';continue
        issue['status']=decision['status'];issue['reason']=decision['reason'];issue['actor']=decision['actor']
        if decision.get('view'):views[issue['id']]={'state':decision['view'],'projection':decision.get('projection',{}),'snapshot':decision.get('snapshot'),'isolate_pair':decision.get('isolate_pair',False)}
    return report,views


def register_tools(mcp,workspace):
    store=CoordinationStore(workspace);jobs=ClashJobs(workspace)
    read={'readOnlyHint':True,'idempotentHint':True}
    write={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True}

    @mcp.tool(annotations=read)
    def coordination_object_schema() -> dict:
        """Read saved-view, view-template, clash-template, run and issue contracts before writing. Shared with the desktop GUI; observations never approve engineering facts."""
        return {'version':1,'kinds':['view','view_template','clash_template','clash_run','issue'],'revision':'Read current object; save with expected_revision and a unique request_id. Historical revisions remain readable.',
            'view':{'name':'View name','state':'ViewerState from get_viewer_workspace'},
            'view_template':{'name':'Template','basis_model_id':'64 hex','filters':'ViewerState.filters','xray':False},
            'clash_template':{'version':1,'id':'test-id','name':'Test','kind':'hard | clearance | service','left':{'classes':['IfcDuctSegment']},'right':{'classes':['IfcBeam']},'tolerance_mm':1,'clearance_mm':0,'max_pairs':20000,'max_triangle_tests':1000000,'max_results':1000,'excluded_pairs':[], 'zones':[]},
            'selector_fields':['ids','classes','categories','models','levels','systems'],'category_key':'JSON tuple, e.g. ["rvt","Mechanical Equipment"] or ["ifc","IfcBeam"], compact JSON with no spaces','empty_selector':'All read physical elements, not a proof of model completeness',
            'zone':{'id':'service-zone','owner_id':'scene element ID','bbox_min_m':[0,0,0],'bbox_max_m':[1,1,1],'basis':'Explicit source/engineering assumption in SI world Z-up'},
            'exclusion':{'a':'scene ID','b':'scene ID','reason':'Decision basis','source_sha256':'Exact revision'},
            'issue':{'status':'new | review | confirmed | accepted | resolved | reopened | question | stale','reason':'Required','actor':'Required','source_sha256':'Exact source','geometry_sha256':'Exact geometry','view':'Optional ViewerState','projection':{'aspect':1.6,'vertical_fov':40}},
            'jobs':'run_clash_test accepts an existing construction model ID or an uploaded derived scene ID; use get_clash_job for counters and cancel_clash_job for cancellation. Repeat interrupted jobs with a NEW request_id; this recomputes instead of claiming a resumed complete check.'}

    @mcp.tool(annotations=read)
    def list_coordination_objects(project_id:str,kind:str,offset:int=0,limit:int=100)->dict:
        """List current named views, templates, collision runs or issue decisions in this project's shared SQLite. Page with offset; no geometry embedded in list."""
        return store.list(project_id,kind,offset,limit)

    @mcp.tool(annotations=read)
    def get_coordination_object(project_id:str,kind:str,object_id:str,revision:int|None=None)->dict:
        """Read a current or historical coordination object before editing it. Saved views and issue decisions are source/geometry pinned."""
        return store.get(project_id,kind,object_id,revision)

    @mcp.tool(annotations=write)
    def save_coordination_object(project_id:str,kind:str,object_id:str,payload:dict,expected_revision:int,request_id:str)->dict:
        """Save a named view, template or explicit issue decision using coordination_object_schema. Preserve provenance; status changes require actor and reason. Does not modify model/project facts."""
        return store.save(project_id,kind,object_id,payload,expected_revision,request_id)

    @mcp.tool(annotations=write)
    def run_clash_test(project_id:str,model_id:str,template:dict,request_id:str)->dict:
        """Start bounded native mesh clash/clearance/service-zone checks over a registered ModelPackage, independent of Revit/AutoCAD. Returns persistent job_id; poll counters. Approximate or missing geometry cannot be certified clear."""
        return jobs.start(project_id,model_id,template,request_id)

    @mcp.tool(annotations=read)
    def get_clash_job(project_id:str,job_id:str,offset:int=0,limit:int=50)->dict:
        """Read actual collision work counters, coverage, partial results, completion, cancellation and errors. An expired heartbeat never proves successful completion."""
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=200:raise ValueError('Invalid result page')
        result=jobs.get(project_id,job_id)
        if result['report']:
            report=result['report'];issues=report['issues'];result['report']={**report,'issues':issues[offset:offset+limit],'contacts':report['contacts'][:limit],
                'issue_total':len(issues),'next_offset':offset+limit if offset+limit<len(issues) else None}
        return result

    @mcp.tool(annotations=read)
    def list_clash_jobs(project_id:str,limit:int=30)->dict:
        """List GUI/MCP collision jobs, including interrupted and failed work, from the common project DB."""
        return jobs.list(project_id,limit)

    @mcp.tool(annotations=write)
    def cancel_clash_job(project_id:str,job_id:str)->dict:
        """Request cooperative cancellation; retain partial coverage. Wait for get_clash_job to report the worker's terminal status."""
        return jobs.cancel(project_id,job_id)

    @mcp.tool(annotations=read)
    def compare_clash_runs(project_id:str,before_id:str,after_id:str,lineage_confirmed:bool=False)->dict:
        """Compare saved runs. Confirm unchanged source lineage/placement for cross-revision comparison. No automatic resolution on incomplete checks, ambiguous IDs or changed rules."""
        return compare_runs(store.get(project_id,'clash_run',before_id)['payload'],store.get(project_id,'clash_run',after_id)['payload'],lineage_confirmed)

    @mcp.tool(annotations=write)
    def export_clash_report(project_id:str,run_id:str,format:str='bcf',bcf_version:str='3.0')->dict:
        """Export source-pinned collision observations/decisions as BCF 2.1/3.0, XLSX or JSON into this project's state export folder. Returns path/hash, not token-heavy binary. No arbitrary target path or external transmission. Native-ID BCF selection needs target-client verification."""
        report,views=report_with_decisions(store,project_id,run_id)
        if format not in {'bcf','xlsx','json'}:raise ValueError('Choose bcf, xlsx or json')
        import json
        raw=bcf(report,views,bcf_version) if format=='bcf' else xlsx(report) if format=='xlsx' else json.dumps(report,ensure_ascii=False).encode()
        digest=hashlib.sha256(raw).hexdigest();folder=workspace.db_path(project_id).parent/'exports';folder.mkdir(exist_ok=True)
        target=folder/('issues-'+digest[:20]+'.'+format)
        if not target.exists():target.write_bytes(raw)
        return {'path':str(target),'bytes':len(raw),'sha256':digest,'source_sha256':report['source_sha256'],'approval_status':report['approval_status']}
