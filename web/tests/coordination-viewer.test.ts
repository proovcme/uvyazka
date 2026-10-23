import test from 'node:test';
import assert from 'node:assert/strict';
import {federate} from '../src/federation.ts';
import type {SceneMember} from '../src/federation.ts';
import {sectionPlane} from '../src/section.ts';
import {geometryKey,validCachedGeometry} from '../src/geometry-cache.ts';
import {measurePoints,measurementRecord,measurementKey} from '../src/spatial-measurements.ts';

function fixture(id:string,origin=[1000000,2000000,30]):SceneMember{
 const binary=new ArrayBuffer(48);new Float32Array(binary,0,9).set([0,0,0,2,0,0,0,3,0]);new Uint32Array(binary,36,3).set([0,1,2]);
 return {instanceId:id,binary,offset:[0,0,0],rotation:0,visible:true,model:{
  contract:'ModelPackage',contract_version:'0.1.0',importer_version:'web-ifc-0.0.78/uvyazka-2',model_id:id,
  source:{filename:id+'.ifc',sha256:id,size_bytes:100,schema:'IFC4',exported_at:'',exporter:'test'},
  coordinate_system:{length_to_m:1,render_origin_m:origin,bounds_min_m:origin,bounds_max_m:origin.map((n,i)=>n+[2,3,0][i]),up_axis:'Z'},
  elements:[{id:'1',step_id:1,global_id:'same-global-id',class:'IfcWall',hierarchy:[],name:'Wall',role:'element',storey_id:'2',predefined_type:null,materials:[],property_sets:{},quantity_sets:{},source:{kind:'explicit',file_sha256:id,step_id:1},geometry_error:null,
    mesh:{bbox_min_m:origin,bbox_max_m:origin.map((n,i)=>n+[2,3,0][i]),position_byte_offset:0,index_byte_offset:36,vertex_count:3,index_count:3,representation_id:1,styles:[],groups:[],source:{kind:'derived',method:'test',version:'1',representation_id:1}}}],
  storeys:[{id:'2',name:'Floor',elevation_m:null,placement_origin_m:null,element_count:1}],relationships:[{step_id:3,class:'IfcRelContainedInSpatialStructure',parent_id:'2',child_ids:['1']}],diagnostics:[],systems:[{id:'4',name:'Test',class:'IfcSystem',member_ids:['1'],connectivity_verified:false}],statistics:{products:1,physical_elements:1,meshes:1,triangles:1,geometry_errors:0,binary_bytes:48},capabilities:{read:true,geometry_ready:true,technology_resolved:false,schedule_ready:false}
 } as any};
}
test('federation keeps world placements and scoped IDs even when both IDs and GlobalIds collide',async()=>{
 const a=fixture('a'),b=fixture('b',[1000010,2000000,30]),before=JSON.stringify(a.model);
 const result=await federate([a,b]),m=result.model;
 assert.deepEqual(m.elements.map(e=>e.id),['a:1','b:1']);assert.equal(m.elements[1].source_element_id,'1');
 assert.equal(m.elements[1].source.file_sha256,'b');assert.equal(m.storeys[1].elevation_m,null);
 assert.deepEqual(m.relationships[1].child_ids,['b:1']);assert.deepEqual(m.systems![1].member_ids,['b:1']);
 const va=new Float32Array(result.binary,m.elements[0].mesh!.position_byte_offset,9),vb=new Float32Array(result.binary,m.elements[1].mesh!.position_byte_offset,9);
 assert.equal(vb[0]-va[0],10);assert.equal(JSON.stringify(a.model),before);
 assert.equal((await federate([a,b])).model.model_id,m.model_id);
 b.offset=[2,0,0];assert.notEqual((await federate([a,b])).model.model_id,m.model_id);
});
test('rotation and offset change vertices and bounds without guessing storey heights',async()=>{
 const a=fixture('a',[0,0,0]);a.rotation=90;a.offset=[10,20,5];const {model,binary}=await federate([a]);
 assert.deepEqual(model.coordinate_system.bounds_min_m,[7,20,5]);assert.deepEqual(model.coordinate_system.bounds_max_m,[10,22,5]);
 const v=new Float32Array(binary,0,9),o=model.coordinate_system.render_origin_m;
 assert.deepEqual([v[3]+o[0],v[4]+o[1],v[5]+o[2]],[10,22,5]);assert.equal(model.storeys[0].elevation_m,null);
 await assert.rejects(federate([a,a]),/ID/);a.offset[0]=NaN;await assert.rejects(federate([a]),/числа/);
});
test('section planes use source axes and origin for both visible geometry and picking',()=>{
 const c=fixture('a').model.coordinate_system;
 for(const [i,axis] of ['X','Y','Z'].entries())for(const reverse of [false,true]){
  const p=sectionPlane(c,axis as any,.5,reverse),world=[...c.render_origin_m];world[i]=p.value-1;
  const local=[world[0]-c.render_origin_m[0],world[2]-c.render_origin_m[2],-(world[1]-c.render_origin_m[1])];
  const signed=p.constant+p.normal.reduce((n,x,k)=>n+x*local[k],0);
  assert.equal(signed,reverse?-1:1);
 }
});
test('measurements retain surface endpoints, signs, source hashes and placement revision',async()=>{
 assert.deepEqual(measurePoints([10,20,30],[13,24,30],'X'),{delta_m:[3,4,0],distance_m:5,value_m:3});
 const m=(await federate([fixture('a'),fixture('b')])).model;
 const r=measurementRecord('project-a',m,{element_id:'a:1',point_m:[0,0,0],triangle_index:0},{element_id:'b:1',point_m:[3,4,0],triangle_index:0},'distance');
 assert.equal(r.value_m,5);assert.equal(r.points[1].source_sha256,'b');assert.equal(r.points[1].source_element_id,'1');assert.equal(r.placements.length,2);assert.equal(r.review_status,'unreviewed');
 assert.notEqual(measurementKey('a'),measurementKey('b'));assert.throws(()=>measurePoints([NaN,0,0],[0,0,0],'distance'));
});
test('geometry cache rejects wrong sources and truncated data',()=>{
 const a=fixture('a'),record={model:a.model,binary:a.binary,accessed:1};
 assert.ok(geometryKey('a').includes('0.0.78'));assert.notEqual(geometryKey('a'),geometryKey('b'));validCachedGeometry(record,'a');
 assert.throws(()=>validCachedGeometry(record,'b'));assert.throws(()=>validCachedGeometry({...record,binary:new ArrayBuffer(4)},'a'));
});
