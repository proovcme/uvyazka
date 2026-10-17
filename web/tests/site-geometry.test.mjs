import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle=await build({stdin:{contents:"export { ConstructionSite } from './site'; export * as THREE from 'three';",resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'ts'},bundle:true,format:'esm',platform:'node',write:false});
const {ConstructionSite,THREE}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({fillRect(){},fillText(){}})})};

test('actual machine meshes remain disjoint at simultaneous work and after backwards seeking',()=>{
  for(const count of [1,4]) {
    const geometry=new THREE.BoxGeometry(10,.3,8), mesh=new THREE.Mesh(geometry,[new THREE.MeshStandardMaterial()]);
    mesh.position.set(100,0,200);mesh.updateMatrixWorld(true);mesh.userData.elementId='slab';
    const model={coordinate_system:{render_origin_m:[0,0,0]},elements:[{id:'slab',role:'element',hierarchy:['IfcSlab']}]};
    const resources=['crane','truck','mixer','concrete_pump','excavator','dump_truck','compactor','vibrator','crew'].map(id=>({id,capacity:count,people_per_slot:2}));
    const operations=resources.flatMap(r=>Array.from({length:count},(_,i)=>({id:r.id+i,kind:'install',target_ids:['slab'],demands:{[r.id]:1}})));
    const events=operations.flatMap(o=>[{time:0,kind:'resource_acquired',resource_id:Object.keys(o.demands)[0],operation_id:o.id,amount:1},{time:100,kind:'resource_released',resource_id:Object.keys(o.demands)[0],operation_id:o.id,amount:1}]).sort((a,b)=>a.time-b.time);
    const run={scenario:{resources,operations,units:[]},events,operation_states:{}};
    const site=new ConstructionSite(model,run,new Map([['slab',mesh]]));
    let blocked=0;
    for(const tick of [0,5,12,25,42,55,70,85,96,100,55]) {
      site.update(tick);
      for(const actor of site.snapshot().actors)for(const worker of actor.workers??[])assert.equal(worker.visible,actor.active,'only assigned workers should be rendered');
      blocked+=site.snapshot().spatialConflicts.length;
      assert.deepEqual(site.equipmentContacts(new Set()),[],`capacity ${count}, tick ${tick}`);
    }
    if(count===4)assert.ok(blocked>0,'competing lifts must be reported, not silently intersect');
    const before=site.snapshot();site.update(1);site.update(55);assert.deepEqual(site.snapshot(),before);
    site.dispose();geometry.dispose();
  }
});
