import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {build} from 'esbuild';
const bundle=await build({entryPoints:[new URL('../src/viewer.ts',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],bundle:true,write:false,format:'esm',plugins:[{name:'three',setup(b){b.onResolve({filter:/^three(?:\/|$)/},args=>({path:import.meta.resolve(args.path),external:true}));}}]});
const {Viewer}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));

// Exercise real presentation methods without constructing a WebGL context.
// A selection must not restyle every original mesh in a large scene.
test('selection and highlighting update only changed owners; global xray still updates all',()=>{
 const viewer:any=Object.create(Viewer.prototype),elements=Array.from({length:300},(_,i)=>({id:String(i),role:'element',mesh:{styles:[{opacity:1}]}}));
 const meshes=new Map(elements.map(e=>{const g=new THREE.BoxGeometry(1,1,1),m=new THREE.MeshStandardMaterial();const mesh=new THREE.Mesh(g,[m]);mesh.userData={filterVisible:true,baseColors:[m.color.clone()]};return [e.id,mesh];}));
 const updates:string[]=[];Object.assign(viewer,{currentElements:elements,elementsById:new Map(elements.map(e=>[e.id,e])),meshes,scene:new THREE.Scene(),edges:new Map(),highlightedElements:new Set(),lightTheme:()=>true,invalidate:()=>{},host:{dataset:{}},batches:{update:(id:string)=>updates.push(id),updateVisibility(){},setXray(){}},showFuture:false,xray:false,sourceColors:false});
 viewer.refreshPresentation();assert.equal(updates.length,300);updates.length=0;
 viewer.select('1');assert.deepEqual(updates,['1']);updates.length=0;viewer.select('2');assert.deepEqual(updates,['1','2']);updates.length=0;
 viewer.highlightElements(new Set(['5','6']));assert.deepEqual(updates,['5','6']);updates.length=0;
 viewer.highlightElements(new Set(['6','7']));assert.deepEqual(updates,['5','7']);updates.length=0;
 viewer.show(new Set(elements.filter(e=>e.id!=='9').map(e=>e.id)));assert.equal(meshes.get('9')!.visible,false);assert.equal(updates.length,0);
 viewer.setXray(true,elements);assert.equal(updates.length,300);assert.ok(meshes.get('2')!.material[0].transparent);
 viewer.select(null);viewer.highlightElements(new Set());assert.equal(viewer.highlight,undefined);
});
