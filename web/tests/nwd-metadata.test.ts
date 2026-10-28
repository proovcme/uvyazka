import test from 'node:test';
import assert from 'node:assert/strict';
import {importNwd,nwdNeedsUnits} from '../src/browser-nwd.ts';
import {modelTreeNodes} from '../src/model-tree-panel.ts';
import {federate} from '../src/federation.ts';
import {specificationDataset,specificationCell} from '../src/model-specification.ts';
import {physicalRow} from '../src/gost-specification.ts';
const hash='a'.repeat(64),guid='12345678-1234-5678-90ab-000000000001';
function fixture(namespace='synthetic'){
 const label=(id:number,display:string,internal:string)=>({serialized_id:id,serialized_class:52,page_index:0,values:{display,internal}});
 const logical={namespace,status:'decoded_logical_subset',stream:namespace+'\\LcOpNwdLogicalHierarchy',declared_property_slots:2,decoded_property_slots:2,property_diagnostics:[],objects:[],
  partition:{tail:{units:{status:'decoded',unit:'mm',scale_to_m:.001}}},nodes:[
   {index:0,serialized_id:100,parent_index:null,name:'Synthetic source',class_name:'LcOaPartition',attributes:[],guid_status:'not_read'},
   {index:1,serialized_id:101,parent_index:0,name:'Вентиляция',class_name:'LcRevitLayer',attributes:[],guid_status:'no_index'},
   {index:2,serialized_id:102,parent_index:1,name:'Приточная установка П1',class_name:'LcRevitFamilyInstance',native_guid:guid,guid_status:'resolved',attributes:[{stream:namespace+'\\LcOaPartitionProps',page_index:0,serialized_id:100},{stream:namespace+'\\LcOaPartitionProps',page_index:0,serialized_id:102}]},
   {index:3,serialized_id:103,parent_index:2,name:null,class_display:'Геометрия',class_name:'LcRevitGeometry',attributes:[],guid_status:'no_index'},
  ],property_objects:[
   {serialized_id:100,serialized_class:66,page_index:0,type_reference:101,record_offset:0,record_bytes:80,values:{uint64_decimal:'9007199254740993',uint64_hex:'20000000000001'}},label(101,'ID элемента','LcRevitId'),
   {serialized_id:102,serialized_class:86,page_index:0,type_reference:103,record_offset:80,record_bytes:120,values:{properties:[{name_reference:104,value:{tag:1,value:7.5}},{name_reference:105,value:{tag:3,value:false}}]}},
   label(103,'Технические данные','synthetic_tech'),label(104,'Мощность','synthetic_power'),label(105,'Резерв','synthetic_reserve'),
  ]};
 return {namespace,logical_model:logical,geometry_complete:true,diagnostics:[],geometry:[{serialized_class:94,record_offset:0,record_bytes:100,positions:[[0,0,0],[1000,0,0],[0,1000,0]],triangles:[[0,1,2]],lines:[],diagnostic:null}],
  fragments:{declared:1,decoded:1,diagnostic:null,rows:[{serialized_id:100,owner_reference:3,geometry_index:0,geometry_kind:4,primitive_count:1,primitive_count_matches:true,local_bounds_match:true,status:'decoded_requires_review',material_raw:[1,0,0],translation:[10000,20000,30000],geometry_origin:[999,999,999],placement_matrix_source_units:[0,1,0,0,-1,0,0,0,0,0,1,0,10000,20000,30000,1],record_offset:0,record_bytes:128}]}};
}
function result(models=[fixture()]){return {container:{source_sha256:hash,source_bytes:1024,serialization_version:448},models,unsupported_features:['saved viewpoints']};}
test('source units replace the manual assumption and explicit rigid placement does not add bounds origin twice',async()=>{
 const input=result();assert.equal(nwdNeedsUnits(input),false);
 const {model,binary}=await importNwd(input,'synthetic.nwd','ft');
 assert.equal(model.source.calibration?.basis,'source');assert.equal(model.source.calibration?.length_to_m,.001);
 assert.deepEqual(model.coordinate_system.bounds_min_m,[9,20,30]);assert.deepEqual(model.coordinate_system.bounds_max_m,[10,21,30]);
 const fragment=model.elements.find(e=>e.nwd?.kind==='fragment')!,mesh=fragment.mesh!;
 const points=new Float32Array(binary,mesh.position_byte_offset,9);
 assert.equal(points[3]+model.coordinate_system.render_origin_m[0],10);assert.equal(points[4]+model.coordinate_system.render_origin_m[1],21);
});
test('native hierarchy, exact Revit identity, source GUID and typed properties remain distinct from geometry fragments',async()=>{
 const {model}=await importNwd(result(),'synthetic.nwd');
 assert.equal(model.nwd?.logical_nodes,4);assert.equal(model.nwd?.fragments,1);assert.equal(model.statistics.physical_elements,0);
 const fragment=model.elements.find(e=>e.nwd?.kind==='fragment')!,source=model.elements.find(e=>e.nwd?.native_guid===guid)!;
 assert.equal(fragment.revit?.element_id,'9007199254740993');assert.equal(fragment.revit?.unique_id,undefined);assert.equal(source.nwd?.native_guid,guid);assert.equal(fragment.global_id,'');
 assert.equal(fragment.property_sets['Технические данные']['Мощность'],7.5);assert.equal(fragment.property_sets['Технические данные']['Резерв'],false);
 assert.ok(source.nwd?.property_sources?.some(s=>s.stream==='synthetic\\LcOaPartitionProps'&&s.record_offset===80));
 const tree=modelTreeNodes(model,model.elements);assert.equal(tree.length,1);assert.equal(tree[0].children[0].name,'Вентиляция');assert.equal(tree[0].children[0].children[0].name,'Приточная установка П1');
 assert.equal(tree[0].items.length,1);assert.equal(tree[0].items[0].id,fragment.id);
 assert.ok(specificationDataset(model).rows.every(row=>!physicalRow(row)));
});
test('federated NWD namespaces can reuse serialized IDs without merging objects or changing source metadata',async()=>{
 const {model,binary}=await importNwd(result([fixture('first'),fixture('second')]),'synthetic.nwd');
 assert.equal(new Set(model.elements.map(e=>e.id)).size,10);assert.equal(model.nwd?.source_models.length,2);
 const before=model.elements.map(e=>({id:e.id,parent:e.nwd?.parent_id,owner:e.nwd?.owner_id}));
 const composed=await federate([{instanceId:'placed-a',model,binary,offset:[1,0,0],rotation:0,visible:true}]);
 const ids=new Set(composed.model.elements.map(e=>e.id));
 for(const e of composed.model.elements){if(e.nwd?.parent_id)assert.ok(ids.has(e.nwd.parent_id));if(e.nwd?.owner_id)assert.ok(ids.has(e.nwd.owner_id));}
 assert.deepEqual(model.elements.map(e=>({id:e.id,parent:e.nwd?.parent_id,owner:e.nwd?.owner_id})),before);
 assert.equal(composed.model.nwd?.source_models.length,2);assert.equal(composed.model.statistics.physical_elements,0);
});
test('unknown units stay pending, partial properties retain a usable tree, invalid index buffers fail before rendering',async()=>{
 const input=result();input.models[0].logical_model.partition.tail.units.status='not_decoded';assert.equal(nwdNeedsUnits(input),true);
 await assert.rejects(()=>importNwd(input,'synthetic.nwd'),/единицы/);
 input.models[0].logical_model.status='unsupported_or_partial';
 const {model}=await importNwd(input,'synthetic.nwd','mm');assert.equal(model.source.calibration?.basis,'user_assumption');assert.equal(model.nwd?.logical_nodes,4);
 input.models[0].geometry[0].triangles=[[0,1,99]];await assert.rejects(()=>importNwd(input,'synthetic.nwd','mm'),/индекс/i);
});

test('scene budget is checked before per-instance allocation and metadata survives federation without meshes',async()=>{
 const input=result();input.models[0].geometry[0].positions.map=()=>{throw Error('over-budget allocation');};
 const {model,binary}=await importNwd(input,'synthetic.nwd',undefined,{geometryBudgetBytes:0});
 assert.equal(binary.byteLength,0);assert.equal(model.statistics.meshes,0);assert.equal(model.capabilities.geometry_ready,false);
 assert.equal(model.nwd?.logical_nodes,4);assert.equal(model.elements.find(e=>e.nwd?.kind==='fragment')?.revit?.element_id,'9007199254740993');
 assert.equal(model.diagnostics.filter(d=>d.kind==='nwd-memory-budget').length,1);
 const composed=await federate([{instanceId:'metadata',model,binary,offset:[0,0,0],rotation:0,visible:true}]);
 assert.equal(composed.model.capabilities.geometry_ready,false);assert.equal(composed.model.nwd?.logical_nodes,4);
});
test('source property names cannot mutate prototypes and specification cells retain inherited source addresses',async()=>{
 const input=result(),props=input.models[0].logical_model.property_objects;
 props.find(p=>p.serialized_id===103)!.values={display:'__proto__',internal:'safe'} as any;
 props.find(p=>p.serialized_id===104)!.values={display:'constructor',internal:'safe'} as any;
 const {model}=await importNwd(input,'synthetic.nwd');
 const fragment=model.elements.find(e=>e.nwd?.kind==='fragment')!;
 assert.equal(fragment.property_sets['__proto__']['constructor'],7.5);assert.equal(({} as any).polluted,undefined);
 const data=specificationDataset(model),column=data.columns.find(c=>c.path?.join('/')==='property_sets/__proto__/constructor')!;
 const cell=specificationCell(data,data.rows[0],column);assert.equal(cell.state,'value');
 const source=(cell.evidence[0].location as any).nwd_source;
 assert.equal(source.source_node_id,'nwd-node:0:2');assert.equal(source.page_index,0);assert.equal(source.record_offset,80);assert.equal(source.stream,'synthetic\\LcOaPartitionProps');
});

test('mirrored placements reverse triangle winding once while preserving source indices',async()=>{
 const r=result();r.models[0].fragments.rows[0].placement_matrix_source_units=[-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const original=[...r.models[0].geometry[0].triangles[0]];const {model,binary}=await importNwd(r,'synthetic.nwd');
 const mesh=model.elements.find(e=>e.mesh)!.mesh!;assert.deepEqual([...new Uint32Array(binary,mesh.index_byte_offset,3)],[0,2,1]);
 assert.deepEqual(r.models[0].geometry[0].triangles[0],original);
});

test('packed browser geometry retains positions, topology and bounds without decimal arrays',async()=>{
 const r:any=result(),b=new ArrayBuffer(48);new Float32Array(b,0,9).set([0,0,0,1000,0,0,0,1000,0]);new Uint32Array(b,36,3).set([0,1,2]);
 r.geometry_binary=new Uint8Array(b);r.packed_geometry=[[{position_byte_offset:0,vertex_count:3,triangle_byte_offset:36,triangle_index_count:3,line_byte_offset:48,line_index_count:0}]];
 r.models[0].geometry[0].positions=[];r.models[0].geometry[0].triangles=[];
 const packed=await importNwd(r,'synthetic.nwd'),plain=await importNwd(result(),'synthetic.nwd');
 assert.deepEqual(packed.model.coordinate_system,plain.model.coordinate_system);assert.deepEqual(new Uint8Array(packed.binary),new Uint8Array(plain.binary));
});

test('large source relationship inventory federates without argument stack overflow',async()=>{
 const {model,binary}=await importNwd(result(),'synthetic.nwd');const relation=model.relationships[0];
 model.relationships=Array.from({length:150000},(_,i)=>({...relation,step_id:i+1}));
 const composed=await federate([{instanceId:'large-synthetic',model,binary,offset:[0,0,0],rotation:0,visible:true}]);
 assert.equal(composed.model.relationships.length,150000);assert.ok(composed.model.relationships.every(r=>r.parent_id.startsWith('large-synthetic:')));
});
