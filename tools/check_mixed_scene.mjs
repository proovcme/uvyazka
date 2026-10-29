/** Real adapters + federation + archive, no renderer stub. Public/synthetic fixtures only.
 * Generate part-a.nwc and part-b.nwc with tools/build_nwd_recovery_fixture.py first.
 * node --experimental-strip-types tools/check_mixed_scene.mjs <fixture-directory>
 */
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {importIfc} from '../web/src/browser-ifc.ts';import {importRvtDirect} from '../web/src/browser-rvt-direct.ts';
import {importNwd,nwdNeedsUnits,NWD_READER_REVISION} from '../web/src/browser-nwd.ts';import {federate,placedPoint} from '../web/src/federation.ts';
import {packWorkspace,unpackWorkspace} from '../web/src/workspace-archive.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.resolve(process.argv[2]??path.join(root,'.uvyazka-build/mixed-scene'));
const runtime=path.join(root,'.uvyazka-build/public-site/uvyazka/runtime'),fixtures=path.join(root,'.uvyazka-build/browser-fixtures');
const hash=data=>createHash('sha256').update(data).digest('hex');
const rvt=await import(pathToFileURL(path.join(runtime,'rvt/uvyazka_rvt_browser.js')));
await rvt.default({module_or_path:await fs.readFile(path.join(runtime,'rvt/uvyazka_rvt_browser_bg.wasm'))});
const nwd=await import(pathToFileURL(path.join(runtime,'nwd/uvyazka_nwd_experiment.js')));
await nwd.default({module_or_path:await fs.readFile(path.join(runtime,'nwd/uvyazka_nwd_experiment_bg.wasm'))});
const require=createRequire(import.meta.url),{IfcAPI}=require(path.join(root,'web/node_modules/web-ifc/web-ifc-api-node.js')),api=new IfcAPI();await api.Init();
const schemas=JSON.parse(await fs.readFile(path.join(runtime,'ifc-hierarchy.json'),'utf8'));
const corpus=JSON.parse(await fs.readFile(path.join(root,'tools/browser-fixtures.json'),'utf8'));
async function publicModel(name){const bytes=await fs.readFile(path.join(fixtures,name)),entry=corpus.find(row=>row.name===name);assert(entry&&hash(bytes)===entry.sha256&&bytes.length===entry.size,'Public fixture has changed');return bytes;}
const rv=await publicModel('RE1-Mechanical.rvt'),ip=await publicModel('RE1-Architecture.ifc');
const packages=[await importRvtDirect(rvt.extractRvtDirectScene(rv),{filename:'RE1-Mechanical.rvt',sha256:hash(rv),size_bytes:rv.length})];
const gh=await fs.readFile(path.join(root,'.uvyazka-build/nwd-research/samples/GateHouse.nwd'));
assert.equal(hash(gh),'ede85d6fa175184b4e6de6b08b3f7be093bdfa4daa66576702958fb97fd96d79');
const assumptions=[];
for(const [filename,bytes]of [['GateHouse.nwd',gh],['part-a.nwc',await fs.readFile(path.join(out,'part-a.nwc'))],['part-b.nwc',await fs.readFile(path.join(out,'part-b.nwc'))]]){
 const inspected=nwd.inspectNwdBytes(bytes,()=>{}),needsUnits=nwdNeedsUnits(inspected);
 assert.equal(inspected.reader_revision,NWD_READER_REVISION,'Runtime revision does not match the adapter');
 if(needsUnits)assumptions.push({filename,unit:'m',basis:filename.endsWith('.nwc')?'synthetic_generator_authored_metres':'explicit_test_assumption_not_coordinate_certification'});
 packages.push(await importNwd(inspected,filename,needsUnits?'m':undefined));
}
const ifc=await importIfc(api,ip,'RE1-Architecture.ifc',hash(ip),schemas,()=>{});ifc.model.source.format='ifc';packages.push(ifc);
const members=packages.map(({model,binary},i)=>({instanceId:model.model_id,model,binary,offset:i===2?[5,-3,2]:[0,0,0],rotation:i===2?-90:0,visible:true}));
const originals=packages.map(pkg=>({json:JSON.stringify(pkg.model),binary:hash(new Uint8Array(pkg.binary))}));
const combined=await federate(members);
assert.equal(combined.model.elements.length,packages.reduce((n,p)=>n+p.model.elements.length,0));
assert.equal(new Set(combined.model.elements.map(e=>e.id)).size,combined.model.elements.length);
assert.deepEqual(new Set(combined.model.federation.members.map(m=>m.source_format)),new Set(['rvt','nwd','nwc','ifc']));
let coordinates=0,relationships=0;const byId=new Map(combined.model.elements.map(e=>[e.id,e]));
for(const member of members){
 assert.deepEqual(combined.model.federation.members.find(m=>m.instance_id===member.instanceId).offset_m,member.offset);
 for(const element of member.model.elements){
  const mapped=byId.get(member.instanceId+':'+element.id);assert(mapped);assert.equal(mapped.source_element_id,element.id);assert.equal(mapped.source_instance_id,member.instanceId);assert.deepEqual(mapped.revit,element.revit);
  if(element.nwd?.parent_id)assert.equal(mapped.nwd.parent_id,member.instanceId+':'+element.nwd.parent_id);
  if(!element.mesh)continue;
  const a=new Float32Array(member.binary,element.mesh.position_byte_offset,element.mesh.vertex_count*3),b=new Float32Array(combined.binary,mapped.mesh.position_byte_offset,mapped.mesh.vertex_count*3);
  for(const index of new Set([0,Math.max(0,element.mesh.vertex_count-1)])){
   const input=[0,1,2].map(k=>a[index*3+k]+member.model.coordinate_system.render_origin_m[k]),expected=placedPoint(input,member.offset,member.rotation);
   for(let k=0;k<3;k++)assert(Math.abs(expected[k]-b[index*3+k]-combined.model.coordinate_system.render_origin_m[k])<.0001,'Federated world coordinates drifted');coordinates++;
  }
 }
 for(const relation of member.model.relationships){assert(combined.model.relationships.some(r=>r.source_instance_id===member.instanceId&&r.class===relation.class&&r.parent_id===member.instanceId+':'+relation.parent_id&&JSON.stringify(r.child_ids)===JSON.stringify(relation.child_ids.map(id=>member.instanceId+':'+id))));relationships++;}
 for(const system of member.model.systems??[]){assert.deepEqual(combined.model.systems.find(s=>s.id===member.instanceId+':'+system.id).member_ids,system.member_ids.map(id=>member.instanceId+':'+id));}
}
const hidden=combined.model.elements.filter(e=>e.source_instance_id===members[1].instanceId).map(e=>e.id);members[1].visible=false;
const selected=combined.model.elements.find(e=>e.source_instance_id===members[0].instanceId).id;
const scene={...combined,id:'public-mixed-scene',project_id:'public-synthetic-qa',name:'Public/synthetic mixed scene',created_at:new Date().toISOString(),members,
 state:{version:1,model_id:combined.model.model_id,source_sha256:combined.model.source.sha256,hidden,selection:[selected],filters:{query:'',levels:[],categories:[],system:'',parameters:[],combine:'all',apply3d:false,grouping:'categories'},view:{position:[20,20,20],target:[0,0,0],up:[0,1,0],planes:[],xray:false},measurements:[],sets:[]}};
const archive=await packWorkspace(scene),restored=await unpackWorkspace(archive);
assert.equal(hash(new Uint8Array(restored.binary)),hash(new Uint8Array(combined.binary)));assert.deepEqual(restored.state,scene.state);
assert.equal(restored.members[1].visible,false);assert.deepEqual(restored.members.map(m=>m.model.source.format),members.map(m=>m.model.source.format));
for(let i=0;i<members.length;i++){assert.equal(hash(new Uint8Array(restored.members[i].binary)),originals[i].binary);assert.equal(JSON.stringify(packages[i].model),originals[i].json);}
await fs.writeFile(path.join(out,'mixed.uvz'),archive);
const report={scope:'actual native/WASM adapters, federation and archive; browser rendering checked separately',source_models:members.map(m=>({filename:m.model.source.filename,sha256:m.model.source.sha256,format:m.model.source.format,read_semantics:m.model.rvt_direct?'graphics_owners':m.model.nwd?'logical_nodes_and_fragments':'ifc_products'})),
 nwc_scope:'independently authored synthetic containers, not Autodesk-exported NWC compatibility evidence',unit_assumptions:assumptions,coordinates_checked:coordinates,relationships_checked:relationships,
 all_source_ids_unique:true,source_packages_unchanged:true,archive_roundtrip:true,visibility_and_selection_preserved:true,coordinate_alignment_verified:false};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
