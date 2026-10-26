import test from 'node:test';
import assert from 'node:assert/strict';
import {engineeringGraph,engineeringPath,engineeringComponent} from '../src/engineering-graph.ts';
import {attachNativeEngineering} from '../src/native-engineering.ts';
import {compareRevisions} from '../src/revision-diff.ts';
import {planarArea,triangleClearance,meshClearance} from '../src/mesh-measure.ts';
import {Triangle,Vector3} from 'three';
import type {ModelPackage} from '../src/model.ts';
const element=(id:string,port=false)=>({id,step_id:Number(id),global_id:'gid-'+id,name:'Элемент '+id,class:port?'IfcDistributionPort':'IfcPump',role:'element',hierarchy:port?['IfcDistributionPort','IfcPort']:['IfcPump','IfcElement'],property_sets:{Technical:{Power:5}},quantity_sets:{},materials:[],source:{file_sha256:'a'.repeat(64)},mesh:null});
const model=()=>({model_id:'a'.repeat(64),source:{sha256:'a'.repeat(64),filename:'synthetic.ifc'},elements:[element('1'),element('2'),element('11',true),element('22',true)],systems:[{id:'sys',name:'В1',class:'IfcSystem',member_ids:['1','2'],connectivity_verified:false}],relationships:[],diagnostics:[]}as unknown as ModelPackage);
test('membership cannot create a physical path; exact port relations retain evidence and unread nodes',()=>{
 const m=model();let g=engineeringGraph(m);assert.equal(engineeringPath(g,'1','2').status,'not_found_in_read_graph');assert.equal(engineeringPath(g,'1','2','membership').status,'found');
 const n=model();n.relationships=[{step_id:51,class:'IfcRelConnectsPortToElement',parent_id:'1',child_ids:['11']},{step_id:52,class:'IfcRelConnectsPortToElement',parent_id:'2',child_ids:['22']},{step_id:53,class:'IfcRelConnectsPorts',parent_id:'11',child_ids:['22','999']}];g=engineeringGraph(n);
 const path=engineeringPath(g,'1','2');assert.equal(path.status,'found');assert.equal(path.links.length,3);assert.equal(path.links[1].source.relation_id,'53');assert.equal(path.links[1].source.sha256,'a'.repeat(64));assert.equal(g.nodes.get('999')?.role,'unread');assert.equal(engineeringComponent(g,'1','physical').ids.includes('999'),false);
});
test('RVT typed base equipment is distinct from members; duplicate mapped IDs stay unread',()=>{
 const m=model();m.elements[0].revit={element_id:'101',phase_status:'unknown'};m.elements[1].revit={element_id:'102',phase_status:'unknown'};
 attachNativeEngineering(m,{status:'extracted_requires_review',diagnostics:[],systems:[{system:{id:50,class:'RbsElectricalSystem',name:'ЩР / 1',member_evidence:[{element_id:101,object_index:1,field:'connections',entry_index:0,connection_type:4,role:'base_equipment_reference'},{element_id:102,object_index:1,field:'connections',entry_index:1,connection_type:1,role:'network_member'}]},source:{stream:'Partitions/1',group_record_offset:42,body_sha256:'b'.repeat(64)}}]},'c'.repeat(64));
 const g=engineeringGraph(m);assert.equal(g.links.filter(x=>x.kind==='membership').length,1);assert.equal(g.links.filter(x=>x.kind==='base_equipment').length,1);assert.equal(engineeringPath(g,'1','2').status,'not_found_in_read_graph');assert.equal(engineeringPath(g,'1','2','membership').status,'found');assert.match(g.links.find(x=>x.kind==='base_equipment')!.source.locator!,/entry|connections\[0\]/);assert.equal(g.links.find(x=>x.kind==='base_equipment')!.source.sha256,'c'.repeat(64));
});
test('revision diff refuses unconfirmed lineage, reports duplicate identities and unknown IDs, distinguishes parameters',()=>{
 const a=model(),b=model();b.model_id='b'.repeat(64);b.source.sha256=b.model_id;b.elements[0].property_sets.Technical.Power=7;b.elements[1].global_id='new';b.elements.push({...b.elements[0],id:'duplicate'});b.elements[2].global_id='';
 assert.throws(()=>compareRevisions(a,b,false),/ревизии/);const r=compareRevisions(a,b,true);assert.ok(r.rows.some(x=>x.kind==='question'&&x.key==='ifc-global:gid-1'));assert.ok(r.rows.some(x=>x.kind==='removed'&&x.before_id==='2'));assert.ok(r.rows.some(x=>x.kind==='added'&&x.after_id==='2'));assert.ok(r.rows.some(x=>x.kind==='question'&&x.after_id==='11'));
 b.elements=b.elements.filter(e=>e.id!=='duplicate');assert.ok(compareRevisions(a,b,true).rows.some(x=>x.kind==='changed'&&x.changes.includes('property_sets')));
});
test('planar area rejects nonplanar and self-crossing polygons; triangle clearance catches edge-through-face intersections',async()=>{
 assert.equal(planarArea([[0,0,0],[3,0,0],[3,2,0],[0,2,0]]),6);assert.throws(()=>planarArea([[0,0,0],[3,0,0],[3,2,0],[0,2,1]]),/плоский/);assert.throws(()=>planarArea([[0,0,0],[2,2,0],[0,2,0],[2,0,0]]),/самопересекается/);
 const tri=(p:number[][])=>new Triangle(...p.map(x=>new Vector3(...x as [number,number,number]))as [Vector3,Vector3,Vector3]);
 const a=tri([[0,0,0],[3,0,0],[0,3,0]]),b=tri([[1,1,-1],[1,1,1],[2,1,1]]);assert.equal(triangleClearance(a,b).distance_m,0);const c=tri([[0,0,2],[3,0,2],[0,3,2]]);assert.equal(triangleClearance(a,c).distance_m,2);
 const m=model();await assert.rejects(meshClearance(m,new ArrayBuffer(0),m.elements[0],m.elements[1]),/геометрия/);
});
