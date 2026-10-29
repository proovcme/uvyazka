import test from 'node:test';import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {zipSync,unzipSync,strToU8} from 'fflate';
import {fixture} from './reliability-fixture.ts';
import {packWorkspace,unpackWorkspace} from '../src/workspace-archive.ts';
import {writeRecovery,readRecovery,listRecovery} from '../src/workspace-autosave.ts';
import {modelCoverage,levelSummary} from '../src/model-coverage.ts';
import {federationBudget} from '../src/federation.ts';
import {elementCategory} from '../src/element-category.ts';
import {revisionIdMap,remapRevisionState} from '../src/source-revision.ts';
test('geometry, properties, systems and views have independent coverage; missing levels are not zero',()=>{
 const {model}=fixture();model.source.format='nwc';model.nwd={logical_nodes:0,fragments:1,source_models:[{namespace:'synthetic',root_id:null,geometry_complete:true,metadata_status:'unread'}],unread_features:['saved views']};
 const items=modelCoverage(model);assert.equal(items.find(row=>row.key==='geometry')!.status,'read');assert.equal(items.find(row=>row.key==='tree')!.status,'unknown');assert.equal(items.find(row=>row.key==='views')!.status,'unsupported');assert.equal(levelSummary(model),'Не прочитаны');assert.deepEqual(JSON.parse(elementCategory(model.elements[0],model).key),['nwd','IfcPump']);
});
test('portable project preserves exact geometry, zero parameters, selection, recipes and source hashes',async()=>{
 const scene=fixture();scene.members=[{instanceId:'source',model:scene.model,binary:scene.binary,offset:[0,0,0],rotation:0,visible:true}];const bytes=await packWorkspace(scene),restored=await unpackWorkspace(bytes);
 assert.deepEqual(new Uint8Array(restored.binary),new Uint8Array(scene.binary));assert.equal(restored.model.elements[0].property_sets.Tech.Power,0);assert.deepEqual(restored.state,scene.state);assert.equal(restored.members[0].model.source.sha256,scene.model.source.sha256);assert.equal(restored.members[0].binary,restored.binary);
});
test('tampered archives and traversal entries are rejected before applying a scene',async()=>{
 const files=unzipSync(await packWorkspace(fixture()));files['scene.json']=strToU8('{}');await assert.rejects(()=>unpackWorkspace(zipSync(files)),/Контрольная сумма/);
 const traversal=unzipSync(await packWorkspace(fixture()));traversal['../private.txt']=strToU8('synthetic');await assert.rejects(()=>unpackWorkspace(zipSync(traversal)),/Недопустимый путь/);
});
test('invalid saved filters, hidden IDs and clipping planes cannot be exported as a valid project',async()=>{
 const scene=fixture();scene.state.hidden=['missing'];await assert.rejects(()=>packWorkspace(scene),/неизвестные элементы/);scene.state.hidden=[];scene.state.view.planes=[{normal:[0,0,0],constant:0}];await assert.rejects(()=>packWorkspace(scene),/Некорректный сохранённый вид/);
});
test('scene composition rejects its budget before allocating an output buffer',()=>{
 const scene=fixture();scene.model.elements[0].mesh!.vertex_count=1_000_000_000;assert.throws(()=>federationBudget([{instanceId:'one',model:scene.model,binary:scene.binary,offset:[0,0,0],rotation:0,visible:true}]),/бюджет/);
});
test('recovery updates state without replacing immutable geometry and isolates different projects',async()=>{
 globalThis.indexedDB=new IDBFactory();const a=fixture();await writeRecovery(a);a.state.hidden=['one'];await writeRecovery(a);const restored=await readRecovery(a.project_id,a.id);assert.deepEqual(restored!.state.hidden,['one']);assert.deepEqual(new Uint8Array(restored!.binary),new Uint8Array(a.binary));
 const b=fixture();b.id='other-draft';b.project_id='other-project';await writeRecovery(b);a.model={...a.model,model_id:'c'.repeat(64)};a.state={...a.state,model_id:a.model.model_id};await writeRecovery(a);assert.equal((await readRecovery(b.project_id,b.id))!.model.model_id,'a'.repeat(64));assert.equal((await listRecovery(a.project_id)).length,1);
});
test('recovery retains three independent sessions without deleting another project payload',async()=>{
 globalThis.indexedDB=new IDBFactory();for(let i=0;i<5;i++){const scene=fixture();scene.id='session-'+i;scene.model.source.filename='synthetic-'+i+'.ifc';await writeRecovery(scene);}const rows=await listRecovery('synthetic-project');assert.equal(rows.length,3);for(const row of rows)assert.ok((await readRecovery(row.project_id,row.id))!.binary.byteLength);
});
test('source revision remaps only unique native identity and keeps the camera in world coordinates',()=>{
 const old=fixture(),after=structuredClone(old.model);after.model_id='c'.repeat(64);after.source.sha256='d'.repeat(64);after.elements[0].id='new';after.coordinate_system.render_origin_m=[100,200,300];old.state.hidden=['one'];old.state.view.planes=[{normal:[1,0,0],constant:0}];old.state.measurements=[{source_sha256:old.model.source.sha256,value_m:12}];
 const mapping=revisionIdMap(old.model,after);assert.equal(mapping.get('one'),'new');const mapped=remapRevisionState(old.state,old.model,after,'member',mapping);assert.deepEqual(mapped.state.hidden,['new']);assert.deepEqual(mapped.state.selection,['new']);assert.deepEqual(mapped.state.view.position,[-99,-298,203]);assert.equal(mapped.state.view.planes[0].constant,100);assert.equal((mapped.state.measurements[0] as any).review_status,'requires_review');assert.equal((mapped.state.measurements[0] as any).source_sha256,old.model.source.sha256);
});
test('duplicate identifiers and matching names never justify revision correspondence',()=>{
 const old=fixture(),after=structuredClone(old.model);after.elements.push({...after.elements[0],id:'two'});assert.equal(revisionIdMap(old.model,after).size,0);after.elements=[{...after.elements[0],id:'changed',global_id:'different'}];assert.equal(revisionIdMap(old.model,after).size,0);const mapped=remapRevisionState(old.state,old.model,after,'member',new Map());assert.equal(mapped.unresolved,1);assert.deepEqual(mapped.state.selection,[]);
});

test('whole-source hiding survives a reader upgrade without guessing missing element identities',()=>{
 const old=fixture();old.state.hidden=['one'];const after=structuredClone(old.model);
 after.elements=[{...after.elements[0],id:'new',global_id:'',source_instance_id:'member',source_element_id:'changed'}, {...after.elements[0],id:'added',global_id:'',source_instance_id:'member',source_element_id:'added'}, {...after.elements[0],id:'other',source_instance_id:'another',source_element_id:'other'}];
 const mapped=remapRevisionState(old.state,old.model,after,'member',new Map(),['member']);
 assert.deepEqual(mapped.state.hidden,['new','added']);assert.deepEqual(mapped.state.selection,[]);assert.equal(mapped.unresolved,2);
 const visible=remapRevisionState(old.state,old.model,after,'member',new Map());assert.deepEqual(visible.state.hidden,[]);
});
