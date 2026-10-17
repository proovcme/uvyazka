/** Replay generated public-demo geometry, without WebGL or private project data. */
import { build } from '../web/node_modules/esbuild/lib/main.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const dir=path.join(root,'.uvyazka-build/public-site/uvyazka/demo');
const bundle=await build({stdin:{contents:"export { ConstructionSite } from './site'; export * as THREE from 'three';",resolveDir:path.join(root,'web/src'),loader:'ts'},bundle:true,format:'esm',platform:'node',write:false});
const {ConstructionSite,THREE}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({fillRect(){},fillText(){}})})};
const files=await readdir(dir),report=[];
for(const file of files.filter(f=>f.startsWith('run-')&&f.endsWith('.json'))) {
  const run=JSON.parse(await readFile(path.join(dir,file),'utf8'));
  const model=JSON.parse(await readFile(path.join(dir,`model-${run.scenario.model_id}.json`),'utf8'));
  const bytes=await readFile(path.join(dir,`geometry-${model.model_id}.bin`));
  const binary=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const group=new THREE.Group();group.rotation.x=-Math.PI/2;
  const meshes=new Map();
  for(const element of model.elements)if(element.mesh) {
    const m=element.mesh,g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(binary,m.position_byte_offset,m.vertex_count*3),3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(binary,m.index_byte_offset,m.index_count),1));g.computeVertexNormals();
    const mesh=new THREE.Mesh(g,m.styles.map(()=>new THREE.MeshStandardMaterial({side:THREE.DoubleSide})));
    mesh.userData.elementId=element.id;group.add(mesh);meshes.set(element.id,mesh);
  }
  group.updateMatrixWorld(true);
  const site=new ConstructionSite(model,run,meshes);
  const ticks=[...new Set([0,run.duration,...Object.values(run.operation_states).flatMap(s=>[s.start,s.start+(s.finish-s.start)*.25,s.start+(s.finish-s.start)*.5,s.start+(s.finish-s.start)*.75,s.finish-.001])])].sort((a,b)=>a-b);
  const result={run:run.scenario.name,ticks:ticks.length,residual:[],blockedFrames:0,activeWorkerFrames:0,movingWorkerFrames:0,workerActions:new Set(),maxUpdateMs:0};
  for(const tick of ticks) {
    const start=performance.now();site.update(tick);result.maxUpdateMs=Math.max(result.maxUpdateMs,performance.now()-start);
    const contacts=site.equipmentContacts(site.completedAt(tick));
    if(contacts.length)result.residual.push({tick,contacts});
    const state=site.snapshot();if(state.spatialConflicts.length)result.blockedFrames++;
    const workers=state.actors.flatMap(a=>a.workers??[]).filter(w=>!w.fallback&&w.action!=='ожидание назначения');
    if(workers.length)result.activeWorkerFrames++;
    if(workers.some(w=>w.action==='перемещение у фронта'))result.movingWorkerFrames++;
    for(const w of workers)result.workerActions.add(w.action);
  }
  result.workerActions=[...result.workerActions];report.push(result);site.dispose();
}
await writeFile(path.join(root,'.uvyazka-build/site-geometry-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.some(r=>r.residual.length||!r.activeWorkerFrames||!r.movingWorkerFrames))process.exitCode=1;
