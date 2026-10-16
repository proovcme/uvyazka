"""Project-scoped IFCCS authoring tools on Uvyazka's existing MCP 1.x server."""
import json
from pathlib import Path

from ..core import connection, digest, encode
from .planning import Planning
from .simulation import canonical_hash


def store_for(workspace, project_id, readonly=False):
    try:
        from .authoring import DrawingProjects
    except ImportError as exc:
        raise ValueError("Install uvyazka[authoring] for drawing/IFC authoring") from exc
    root = workspace.db_path(project_id).parent / "construction"
    allowed=[workspace.project(project_id)['source_root']]
    managed=(root.parent/'uploads').resolve()
    if managed.is_dir():
        if not managed.is_relative_to(root.parent.resolve()):raise ValueError('Upload directory is outside the project state')
        allowed.append(managed)
    return DrawingProjects(root,allowed,readonly=readonly)


def source_links(workspace, project_id, drawing_id):
    with connection(workspace.db_path(project_id), readonly=True) as db:
        if not db.execute("select 1 from sqlite_master where name='drawing_source_links'").fetchone():
            return []
        return [json.loads(r[0]) for r in db.execute("select payload from drawing_source_links where drawing_id=?", (drawing_id,))]


def scoped(result, project_id, drawing_id):
    """Keep upstream drawing IDs distinct and link to Uvyazka's own viewer."""
    result = {**result, "project_id": project_id, "drawing_id": drawing_id}
    for key in ("build", "active_build"):
        if result.get(key):
            result[key] = {**result[key], "viewer_url": "/simulation/?project=" + project_id}
    return result


def adopt(workspace, project_id, model_id, sources, request_id, fingerprint=None):
    p=Planning(workspace); folder=workspace.db_path(project_id).parent/"construction/models"/model_id
    model=json.loads((folder/"manifest.json").read_text(encoding="utf-8"))
    model["project_id"]=project_id; model["source"]["sources"]=sources
    return p._save(project_id,"construction_models",model,request_id,fingerprint or canonical_hash([model_id,sources]))


def import_rvt_document(workspace,project_id,doc_id,request_id):
    """Shared registered-document operation for direct import and RVT preparation."""
    doc,path=workspace.source_record(project_id,doc_id)
    if path.suffix.lower()!='.rvt':raise ValueError('Choose a registered RVT')
    if not path.is_file() or not 0<path.stat().st_size<=512*1024*1024:raise ValueError('RVT source must be a file <=512 MiB')
    pointer={'doc_id':doc_id,'sha256':doc['sha256'] or digest(path),'locator':'Native RVT model'}
    p=Planning(workspace);p.validate_sources(project_id,[pointer])
    store=store_for(workspace,project_id)
    from .rvt import import_identity
    name=Path(doc['relative_path']).name
    identity=import_identity(path,name)
    fingerprint=canonical_hash(['rvt',doc_id,pointer['sha256'],identity])
    if old:=p._retry(project_id,request_id,fingerprint):return old
    result=store.import_rvt(name,path=str(path))
    p.validate_sources(project_id,[pointer])
    if result['model_id']!=identity:raise ValueError('RVT or converter changed during import; retry after checking versions')
    return adopt(workspace,project_id,result['model_id'],[pointer],request_id,fingerprint)


def register_tools(mcp,workspace):
    from mcp.server.fastmcp import Image
    read={"readOnlyHint":True,"idempotentHint":True}
    write={"readOnlyHint":False,"destructiveHint":False,"idempotentHint":False}

    @mcp.tool(annotations=read)
    def rvt_converter_status() -> dict:
        """Check local RVT converter, metadata reader, installation paths and managed binary integrity. No model is opened; no Revit, cloud service or BIM Python libraries are required for this check."""
        from .rvt_runtime import converter_status
        return converter_status()

    @mcp.tool(annotations=read)
    def get_rvt_conversion(project_id:str,model_id:str,section:str="summary",offset:int=0,limit:int=40) -> dict:
        """Read conversion provenance and local derived IFC paths, or a bounded diagnostics page. Sections: summary, warnings, skipped, unsupported_features, validation, repairs. These are working copies; original RVT remains untouched."""
        from .planning import bounded
        p=Planning(workspace); model=p.model(project_id,model_id)
        conversion=model['source'].get('conversion')
        if model['source'].get('format')!='rvt' or not conversion:
            raise ValueError('Choose a converted RVT model from this project')
        root=p.model_path(project_id,model_id)
        scope={'project_id':project_id,'model_id':model_id}
        if section=='summary':
            return {**scope,'source_sha256':model['source']['sha256'],
                'conversion':{k:v for k,v in conversion.items() if k not in {'warnings','skipped','unsupported_features','normalization'}},
                'phase_status':model.get('revit',{}).get('status','unavailable'),
                'artifacts':{name:str(root/name) for name in ['converted.ifc','raw-converted.ifc','conversion-diagnostics.json','ifc-validation.json','conversion-repairs.json'] if (root/name).is_file()},
                'diagnostic_counts':{key:len(conversion.get(key,[])) for key in ['warnings','skipped','unsupported_features']}}
        if section in {'warnings','skipped','unsupported_features'}:
            rows=conversion.get(section,[])
        elif section in {'validation','repairs'}:
            path=root/('ifc-validation.json' if section=='validation' else 'conversion-repairs.json')
            if not path.is_file() or path.stat().st_size>16*1024*1024: raise ValueError('Diagnostics unavailable or exceed 16 MiB')
            rows=json.loads(path.read_text(encoding='utf-8'))
        else: raise ValueError('Unknown RVT diagnostic section')
        return {**scope,'section':section,**bounded(rows,offset,limit)}

    @mcp.tool(annotations=read)
    def ifc_authoring_schema() -> dict:
        """Read the exact typed IFC4 authoring schema. The client model interprets drawings; no built-in LLM or OCR. Every storey/element needs evidence. DWG requires a CAD adapter; PDF/DXF/image coordinates need explicit calibration."""
        from .model_spec import ModelSpec,DrawingFrame
        return {"model":ModelSpec.model_json_schema(),"drawing_frame":DrawingFrame.model_json_schema(),
            "workflow":["create_drawing_model","register_model_drawing","inspect_model_drawing / render_model_drawing","save_ifc_model_spec","build_drawing_model","suggest_ifc_scenario / run_construction_scenario"],
            "status":"Drawing interpretation, technology and calculations require review"}

    @mcp.tool(annotations=write)
    def create_drawing_model(project_id:str,name:str) -> dict:
        """Create a revisioned drawing-to-IFC workspace inside the selected Uvyazka project. Returns a drawing_id; keep project_id and drawing_id distinct."""
        result=store_for(workspace,project_id).create(name)
        return {"project_id":project_id,"drawing_id":result["id"],"revision":result["revision"]}

    @mcp.tool(annotations=write)
    def register_model_drawing(project_id:str,drawing_id:str,doc_id:str,expected_revision:int) -> dict:
        """Attach a registered document to a drawing model, preserving bytes and SHA. No arbitrary filesystem access. Returns source.id for model-spec evidence."""
        doc,path=workspace.source_record(project_id,doc_id)
        if not path.is_file() or not 0 < path.stat().st_size <= 50*1024*1024:
            raise ValueError("Drawing source must be a file <=50 MiB")
        pointer={"doc_id":doc_id,"sha256":doc["sha256"] or digest(path),"locator":"Drawing source for "+drawing_id}
        Planning(workspace).validate_sources(project_id,[pointer])
        result=store_for(workspace,project_id).register_source(drawing_id,expected_revision,path.name,path=str(path))
        with connection(workspace.db_path(project_id)) as db:
            db.execute("create table if not exists drawing_source_links(drawing_id text,source_id text,payload text,primary key(drawing_id,source_id))")
            db.execute("insert or replace into drawing_source_links values (?,?,?)",(drawing_id,result["source"]["id"],encode(pointer)))
        return scoped(result,project_id,drawing_id)

    @mcp.tool(annotations=read)
    def inspect_model_drawing(project_id:str,drawing_id:str,source_id:str,page:int=1,offset:int=0,limit:int=100) -> dict:
        """Read bounded PDF text/vector primitives, DXF entities or image metadata with source coordinates."""
        return scoped(store_for(workspace,project_id,True).inspect(drawing_id,source_id,page,offset,min(max(1,limit),200)),project_id,drawing_id)

    @mcp.tool(annotations=read)
    def render_model_drawing(project_id:str,drawing_id:str,source_id:str,page:int=1,region:list[float]|None=None) -> Image:
        """Render one registered drawing page or region for the client model's visual interpretation."""
        return Image(data=store_for(workspace,project_id,True).render(drawing_id,source_id,page,region),format="png")

    @mcp.tool(annotations=write)
    def save_ifc_model_spec(project_id:str,drawing_id:str,expected_revision:int,spec:dict) -> dict:
        """Validate and save the complete typed model specification with explicit dimensions, evidence and assumptions. Existing revisions cannot be overwritten by stale callers."""
        return scoped(store_for(workspace,project_id).set_spec(drawing_id,expected_revision,spec),project_id,drawing_id)

    @mcp.tool(annotations=read)
    def get_drawing_model(project_id:str,drawing_id:str,offset:int=0,limit:int=40) -> dict:
        """Read model-workspace revision, attached sources, build status and a bounded page of specified elements."""
        from .planning import bounded
        store=store_for(workspace,project_id,True); result=store.get(drawing_id)
        return scoped({**store.summary(result),"spec_metadata":{k:v for k,v in (result.get("spec") or {}).items() if k!="elements"},
            **bounded((result.get("spec") or {}).get("elements",[]),offset,limit)},project_id,drawing_id)

    @mcp.tool(annotations=write)
    def build_drawing_model(project_id:str,drawing_id:str,expected_revision:int,request_id:str) -> dict:
        """Build IFC4, reopen it, check EXPRESS and element geometry, then publish to this project's existing viewer/model store. No regulatory or drawing-interpretation certification."""
        pointers=source_links(workspace,project_id,drawing_id)
        Planning(workspace).validate_sources(project_id,pointers)
        result=store_for(workspace,project_id).build(drawing_id,expected_revision)
        return scoped({**result,"model":adopt(workspace,project_id,result["build"]["model_id"],pointers,request_id)},project_id,drawing_id)

    @mcp.tool(annotations=read)
    def render_spatial_model(project_id:str,model_id:str,azimuth:float=45,elevation:float=35,cut_z:float|None=None) -> Image:
        """Render actual stored triangles to PNG without a browser; inspect generated IFC or imported models and a horizontal section."""
        from .model_preview import preview
        p=Planning(workspace)
        return Image(data=preview(p.model(project_id,model_id),(p.model_path(project_id,model_id)/"geometry.bin").read_bytes(),azimuth,elevation,cut_z),format="png")

    @mcp.tool(annotations=write)
    def federate_spatial_models(project_id:str,members:list[dict],request_id:str) -> dict:
        """Combine up to 32 models from this project. Each member: model_id, unique instance_id, optional label, offset_m:[x,y,z] in metres, rotation_deg around Z. Shared coordinates are not automatically verified. Original packages remain unchanged."""
        from .federation import create_federation
        p=Planning(workspace); sources=[]
        for member in members:
            model=p.model(project_id,member.get("model_id")); sources.extend(model["source"].get("sources",[]))
        sources=list({encode(s):s for s in sources}.values());p.validate_sources(project_id,sources)
        result=create_federation(workspace.db_path(project_id).parent/"construction",members)
        return adopt(workspace,project_id,result["model_id"],sources,request_id)

    @mcp.tool(annotations=write)
    def import_rvt_model(project_id:str,doc_id:str,request_id:str) -> dict:
        """Convert a registered RVT locally using the included rvt-rs source (build with tools/setup_rvt.py), reopen/validate IFC and publish the model. Check rvt_converter_status first; use get_rvt_conversion for derived IFC and diagnostics. No Revit or cloud. Unknown/box geometry cannot supply work volumes."""
        return import_rvt_document(workspace,project_id,doc_id,request_id)
