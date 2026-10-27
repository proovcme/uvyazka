"""Shared collision engine over ModelPackage meshes; used by native and Pyodide."""
from __future__ import annotations

import hashlib
import json
import math
import struct
from datetime import datetime, timezone

from .clash_geometry import Mesh, Node, bounds, Budget, BudgetExceeded, Cancelled, compare, cross, sub, length, box_distance, EPS

REVISION = 'mesh-bvh-1'


def hashed(value): return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def validate_rule(rule):
    if not isinstance(rule, dict) or set(rule)-{'version','id','name','kind','left','right','tolerance_mm','clearance_mm','max_pairs','max_triangle_tests','max_results','excluded_pairs','zones'}:
        raise ValueError('Unknown collision template field')
    if type(rule.get('version')) is not int or rule['version'] != 1 or rule.get('kind') not in {'hard','clearance','service'}: raise ValueError('Collision rule version/kind required')
    for k in ('id','name'):
        if not isinstance(rule.get(k), str) or not 1 <= len(rule[k]) <= 160: raise ValueError('Rule ID and name required')
    for side in ('left','right'):
        selector = rule.get(side)
        if not isinstance(selector, dict) or set(selector)-{'ids','classes','categories','models','levels','systems'}: raise ValueError('Explicit selection required')
        for key, values in selector.items():
            if not isinstance(values, list) or len(values)>10000 or any(not isinstance(s,str) or not 1<=len(s)<=512 for s in values): raise ValueError('Bounded selection strings required')
    for key, maximum, default in [('tolerance_mm',1000,1),('clearance_mm',100000,0),('max_pairs',200000,20000),('max_triangle_tests',10000000,1000000),('max_results',10000,1000)]:
        value=rule.get(key, default)
        if type(value) not in (int,float) or not math.isfinite(value) or not 0<=value<=maximum: raise ValueError('Invalid '+key)
        if key.startswith('max_') and (type(value) is not int or value<1): raise ValueError('Positive integer budget required')
    if rule['kind']=='clearance' and rule.get('clearance_mm',0)<=0: raise ValueError('Positive clearance in mm required')
    if not isinstance(rule.get('excluded_pairs',[]),list) or len(rule.get('excluded_pairs',[]))>10000:raise ValueError('Invalid exclusions')
    for row in rule.get('excluded_pairs',[]):
        if not isinstance(row,dict) or set(row)!={'a','b','reason','source_sha256'} or any(not isinstance(row[k],str) or not row[k] or len(row[k])>512 for k in row):raise ValueError('Exclusion needs two IDs, source hash and reason')
    if rule['kind']=='service' and not rule.get('zones'):raise ValueError('Explicit service zones required')
    if not isinstance(rule.get('zones',[]),list) or len(rule.get('zones',[]))>1000:raise ValueError('Invalid zones')
    for zone in rule.get('zones',[]):
        if not isinstance(zone,dict) or set(zone)!={'id','owner_id','bbox_min_m','bbox_max_m','basis'}:raise ValueError('Service zone fields required')
        if any(not isinstance(zone[k],str) or not 1<=len(zone[k])<=512 for k in ('id','owner_id','basis')):raise ValueError('Zone ID/owner/basis required')
        for key in ('bbox_min_m','bbox_max_m'):
            if not isinstance(zone[key],list) or len(zone[key])!=3 or any(type(x) not in (int,float) or not math.isfinite(x) or abs(x)>1e8 for x in zone[key]):raise ValueError('Zone needs finite metre coordinates')
        if any(a>=b for a,b in zip(zone['bbox_min_m'],zone['bbox_max_m'])):raise ValueError('Zone dimensions must be positive')
    return rule


def selected(e, selector, model):
    member=next((m for m in model.get('federation',{}).get('members',[]) if m.get('instance_id')==e.get('source_instance_id')), {})
    fmt=member.get('source_format') or model['source'].get('format')
    if fmt=='nwd':category=['nwd',e.get('class','')]
    elif fmt=='rvt' or e.get('revit',{}).get('id_basis')=='rvt_converter_tag':
        raw=e.get('property_sets',{}).get('Other',{}).get('Category');category=['rvt',raw.strip() if isinstance(raw,str) and raw.strip() else 'Категория Revit не прочитана']
    else:category=['ifc',e.get('class','')]
    values={'ids':[e['id']], 'classes':e.get('hierarchy',[e.get('class','')])+[e.get('class','')],
            'categories':[json.dumps(category,ensure_ascii=False,separators=(',',':'))],
            'models':[e.get('source_instance_id',''),e.get('source_model_id',model['model_id'])], 'levels':[e.get('storey_id','')],
            'systems':[s['id'] for s in model.get('systems',[]) if e['id'] in s.get('member_ids',[])]}
    return all(not wanted or any(x in values[key] for x in wanted) for key,wanted in selector.items())


def element_ref(e, model):
    return {'id':e['id'],'name':e.get('name',''),'class':e.get('class',''), 'level':e.get('storey_id'),
            'source_sha256':e.get('source',{}).get('file_sha256',model['source']['sha256']),
            'source_instance_id':e.get('source_instance_id'), 'ifc_guid':e.get('global_id') or None,
            'revit_id':e.get('revit',{}).get('element_id'), 'unique_id':e.get('revit',{}).get('unique_id'),
            'geometry_basis':e.get('geometry_evidence') or e.get('mesh',{}).get('source') if e.get('mesh') else None}


def decode(e, model, binary):
    mesh=e.get('mesh')
    if not mesh or mesh.get('primitive')=='lines':raise ValueError('No triangle geometry')
    vc,ic,po,io=[mesh[k] for k in ('vertex_count','index_count','position_byte_offset','index_byte_offset')]
    if any(type(x) is not int or x<0 for x in (vc,ic,po,io)) or not 3<=vc<=500000 or not 3<=ic<=1500000 or ic%3 or po%4 or io%4 or po+vc*12>len(binary) or io+ic*4>len(binary):raise ValueError('Invalid mesh byte ranges')
    origin=model['coordinate_system']['render_origin_m']
    vertices=[tuple(p[k]+origin[k] for k in range(3)) for p in struct.iter_unpack('<fff',memoryview(binary)[po:po+vc*12])]
    if any(not math.isfinite(x) or abs(x)>1e8 for p in vertices for x in p):raise ValueError('Invalid mesh coordinates')
    indices=[x[0] for x in struct.iter_unpack('<I',memoryview(binary)[io:io+ic*4])]
    if max(indices)>=vc:raise ValueError('Mesh index out of range')
    if any(length(cross(sub(vertices[indices[i+1]],vertices[indices[i]]),sub(vertices[indices[i+2]],vertices[indices[i]])))<1e-18 for i in range(0,ic,3)):raise ValueError('Degenerate triangle')
    return Mesh(vertices,indices)


def run_clashes(model, binary, rule, progress=None, cancelled=lambda:False):
    validate_rule(rule)
    if model.get('contract')!='ModelPackage' or model.get('contract_version')!='0.1.0':raise ValueError('ModelPackage required')
    coordinates=model['coordinate_system'];scale=coordinates.get('length_to_m')
    # ModelPackage positions and render_origin_m are ALREADY in metres.
    # length_to_m records the source conversion, not a second mesh multiplier.
    if coordinates.get('up_axis')!='Z' or type(scale) not in (int,float) or not math.isfinite(scale) or scale<=0:raise ValueError('Metre-normalized Z-up ModelPackage with known source scale required')
    origin=coordinates.get('render_origin_m')
    if not isinstance(origin,list) or len(origin)!=3 or any(type(x) not in (int,float) or not math.isfinite(x) or abs(x)>1e8 for x in origin):raise ValueError('Finite metre render origin required')
    if len(binary)!=model['statistics']['binary_bytes']:raise ValueError('Incomplete binary')
    if len(model.get('elements',[]))>100000:raise ValueError('Element budget exceeded')
    elements=model['elements'];by_id={e['id']:e for e in elements}
    if len(by_id)!=len(elements):raise ValueError('Duplicate scene IDs')
    left=[e for e in elements if e.get('role')=='element' and selected(e,rule['left'],model)]
    right=[e for e in elements if e.get('role')=='element' and selected(e,rule['right'],model)]
    if rule['kind']=='service':
        from .geometry import box_model
        zones=[]
        for z in rule['zones']:
            if z['owner_id'] not in by_id:raise ValueError('Service-zone owner is absent')
            virtual,data=box_model('Explicit service zone',[{'id':'zone:'+z['id'],'name':z['basis'],'bbox_min_m':z['bbox_min_m'],'bbox_max_m':z['bbox_max_m'],'geometry_basis':z['basis']}],[],[])
            e=virtual['elements'][0];e['_zone_model']=virtual;e['_zone_binary']=data;e['_zone_owner']=z['owner_id'];zones.append(e)
        left=zones
    report={'version':1,'engine':REVISION,'model_id':model['model_id'],'source_sha256':model['source']['sha256'], 'source_filename':model['source']['filename'], 'render_origin_m':model['coordinate_system']['render_origin_m'], 'geometry_sha256':hashlib.sha256(binary).hexdigest(),
            'rule':rule,'rule_hash':hashed(rule),'created_at':datetime.now(timezone.utc).isoformat(),'issues':[],'contacts':[],
            'coverage':{'left':len(left),'right':len(right),'eligible':0,'candidates':0,'checked_pairs':0,'excluded_pairs':0,'triangle_tests':0,'unread':[]},'status':'running','complete':False,
            'approval_status':'geometric_observations_not_engineering_approval'}
    coverage=report['coverage'];meshes={};approximate=set();prepared_triangles=0
    unique=list({x['id']:x for x in left+right}.values())
    coverage.update(phase='preparing_geometry',prepared_elements=0,selected_elements=len(unique))
    if progress:progress(report)
    for index,e in enumerate(unique):
        if cancelled():report['status']='cancelled';return report
        if e.get('semantic_kind')=='geometry_fragment':approximate.add(e['id'])
        try:
            count=(e.get('mesh') or {}).get('index_count',0)
            if type(count) is int and prepared_triangles+count//3>2000000:
                raise ValueError('Geometry preparation budget reached (2,000,000 triangles); narrow the selections')
            meshes[e['id']]=decode(e,e.get('_zone_model',model),e.get('_zone_binary',binary))
            prepared_triangles+=len(meshes[e['id']].triangles)
            evidence=e.get('geometry_evidence') or {}
            method=(e.get('mesh') or {}).get('source',{}).get('method','')
            if not e.get('_zone_owner') and (not meshes[e['id']].closed or evidence.get('requires_review') or 'box' in method or 'envelope' in method):approximate.add(e['id'])
        except (ValueError,KeyError,TypeError,struct.error) as ex:coverage['unread'].append({'id':e['id'],'reason':str(ex)})
        coverage['prepared_elements']=index+1
        if progress and (index%5==0 or index+1==len(unique)):progress(report)
    coverage['eligible']=len(meshes)
    coverage['approximate_ids']=sorted(approximate)
    coverage['open_mesh_ids']=[key for key,mesh in meshes.items() if not mesh.closed]
    coverage['phase']='checking_pairs'
    def pulse(tests):
        coverage['triangle_tests']=tests
        if progress:progress(report)
    budget=Budget(rule.get('max_triangle_tests',1000000),cancelled,pulse)
    margin=rule.get('clearance_mm',0)/1000 if rule['kind']=='clearance' else 0
    tolerance=rule.get('tolerance_mm',1)/1000
    right=sorted((e for e in right if e['id'] in meshes),key=lambda e:meshes[e['id']].box[0][0])
    boxes=[meshes[e['id']].box for e in right]
    def build_index(indices):
        box=bounds([point for i in indices for point in boxes[i]])
        if len(indices)<=8:return Node(box,indices)
        axis=max(range(3),key=lambda i:box[1][i]-box[0][i])
        indices.sort(key=lambda i:boxes[i][0][axis]+boxes[i][1][axis]);split=len(indices)//2
        return Node(box,[],build_index(indices[:split]),build_index(indices[split:]))
    root=build_index(list(range(len(right)))) if right else None
    coverage['broadphase_tests']=0;coverage['processed_left']=0
    def nearby(box):
        stack=[root] if root else []
        while stack:
            if cancelled():raise Cancelled()
            node=stack.pop();coverage['broadphase_tests']+=1
            if coverage['broadphase_tests']>2000000:raise BudgetExceeded('Broad-phase budget exhausted; narrow the selections')
            if box_distance(box,node.box)>margin+EPS:continue
            if node.left:stack.extend((node.right,node.left))
            else:
                for i in node.indices:
                    if box_distance(box,boxes[i])<=margin+EPS:yield right[i]
    seen=set();excluded={tuple(sorted((r['a'],r['b']))) for r in rule.get('excluded_pairs',[]) if r['source_sha256']==model['source']['sha256']}
    try:
        for index,a in enumerate(left):
            if a['id'] not in meshes:continue
            ma=meshes[a['id']]
            for b in nearby(ma.box):
                if cancelled():raise Cancelled()
                pair=tuple(sorted((a['id'],b['id'])))
                if a['id']==b['id'] or a.get('_zone_owner')==b['id'] or pair in seen:continue
                if box_distance(ma.box,meshes[b['id']].box)>margin+EPS:continue
                seen.add(pair);coverage['candidates']+=1
                if coverage['checked_pairs']>=rule.get('max_pairs',20000):raise BudgetExceeded('Pair budget exhausted')
                if pair in excluded:coverage['excluded_pairs']+=1;continue
                result=compare(ma,meshes[b['id']],margin,tolerance,budget)
                coverage['checked_pairs']+=1;coverage['triangle_tests']=budget.tests
                if result:
                    question=a['id'] in approximate or b['id'] in approximate or result['kind']=='question'
                    if result['kind']=='contact' and not question:report['contacts'].append({'a':a['id'],'b':b['id'],**result})
                    else:
                        ar=element_ref(by_id[a['_zone_owner']] if a.get('_zone_owner') else a,model);br=element_ref(b,model)
                        report['issues'].append({'id':hashed([rule['id'],model['source']['sha256'],pair])[:32],'a':ar,'b':br,'kind':'question' if question else result['kind'],
                            'status':'new','evidence':result,'zone_basis':a.get('name') if a.get('_zone_owner') else None,'reason':'Approximate, fragment or uncertain geometry' if question else 'Intersection/distance in the extracted meshes; review required'})
                if len(report['issues'])>=rule.get('max_results',1000):raise BudgetExceeded('Result budget exhausted')
                if progress and coverage['checked_pairs']%10==0:progress(report)
            coverage['processed_left']=index+1
            if progress and index%10==0:progress(report)
        report['status']='complete'
    except BudgetExceeded as ex:report['status']='partial';report['stop_reason']=str(ex)
    except Cancelled:report['status']='cancelled'
    coverage['triangle_tests']=budget.tests
    coverage['phase']='finished'
    report['complete']=report['status']=='complete' and bool(left) and bool(right) and not coverage['unread'] and not approximate and not any(i['kind']=='question' for i in report['issues'])
    report['scope']='Read ModelPackage elements only; missing original RVT/IFC/NWD objects cannot be counted as checked'
    if not left or not right:report['stop_reason']='One or both selections are empty; no complete verification'
    if progress:progress(report)
    return report
