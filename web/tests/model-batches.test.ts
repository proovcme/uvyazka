import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {ModelBatches} from '../src/model-batches.ts';import type {SourceMesh} from '../src/model-batches.ts';
function source(id:string,line=false):SourceMesh{
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array([0,0,0,1,0,0,0,1,0]),3));geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(line?[]:[0,1,2]),1));if(!line)geometry.addGroup(0,3,0);
 const material=new THREE.MeshStandardMaterial({color:0x389dab,side:THREE.DoubleSide,flatShading:true});const mesh=new THREE.Mesh(geometry,[material]);mesh.userData={elementId:id,role:'element',sourcePrimitive:line?'lines':'triangles'};
 if(line){const child=geometry.clone();child.setIndex(new THREE.BufferAttribute(new Uint32Array([0,1]),1));const segments=new THREE.LineSegments(child,new THREE.LineBasicMaterial({color:material.color}));segments.userData={sourceLines:true,elementId:id};mesh.add(segments);}
 return mesh;
}
test('batching preserves exact source meshes, group ranges, colors and pick/measurement indices',()=>{
 const root=new THREE.Group();root.rotation.x=-Math.PI/2;const a=source('rvt:1'),b=source('ifc:2');b.position.x=2;root.add(a,b);
 // Current viewer positions are baked into the binary, source proxy local transforms are identity.
 b.position.x=0;const positions=a.geometry.getAttribute('position').array.slice(),indices=a.geometry.index!.array.slice();
 const batches=new ModelBatches(root,new Map([['rvt:1',a],['ifc:2',b]]));root.updateMatrixWorld(true);
 assert.equal(batches.count,1);assert.equal(a.parent,batches.proxyRoot);assert.deepEqual(a.geometry.getAttribute('position').array,positions);assert.deepEqual(a.geometry.index!.array,indices);
 const batch=root.children.find((o):o is THREE.BatchedMesh=>o instanceof THREE.BatchedMesh)!;assert.equal(batch.instanceCount,2);
 const range=batch.getGeometryRangeAt(0);assert.equal(range.indexCount,3);assert.equal(range.vertexCount,3);
 const color=new THREE.Vector4();batch.getColorAt(0,color);assert.deepEqual(color.toArray(),[a.material[0].color.r,a.material[0].color.g,a.material[0].color.b,1].map(Math.fround));
 const ray=new THREE.Raycaster(new THREE.Vector3(.2,2,-.2),new THREE.Vector3(0,-1,0));const hit=ray.intersectObject(a,false)[0];assert(hit);assert.equal(hit.object.userData.elementId,'rvt:1');assert.equal(hit.faceIndex,0);assert.deepEqual([hit.face!.a,hit.face!.b,hit.face!.c],[0,1,2]);
 let disposed=0;a.geometry.addEventListener('dispose',()=>disposed++);batches.dispose();assert.equal(disposed,0);assert.equal(a.parent,root);assert.deepEqual(a.geometry.index!.array,indices);
});
test('visibility, selected overlays, clipping, xray and simulation restore remain independent of source data',()=>{
 const root=new THREE.Group(),mesh=source('native:7');root.add(mesh);const batches=new ModelBatches(root,new Map([['native:7',mesh]])),batch=root.children.find((o):o is THREE.BatchedMesh=>o instanceof THREE.BatchedMesh)!;
 mesh.visible=false;batches.updateVisibility('native:7',false);assert.equal(batch.getVisibleAt(0),false);
 mesh.visible=true;batches.update('native:7',mesh,true);assert.equal(mesh.parent,root);assert.equal(batch.getVisibleAt(0),false);
 batches.update('native:7',mesh,false);assert.equal(mesh.parent,batches.proxyRoot);assert.equal(batch.getVisibleAt(0),true);
 const planes=[new THREE.Plane(new THREE.Vector3(1,0,0),-.2)];batches.clip(planes);assert.equal(batch.material.clippingPlanes,planes);
 mesh.material[0].opacity=.2;batches.setXray(true);batches.update('native:7',mesh,false);assert.equal(batch.material.transparent,true);const color=new THREE.Vector4();batch.getColorAt(0,color);assert(Math.abs(color.w-.2)<1e-7);
 batches.setEnabled(false);assert.equal(batch.visible,false);assert.equal(mesh.parent,root);batches.setEnabled(true);assert.equal(mesh.parent,batches.proxyRoot);assert.equal(batch.visible,true);
 batches.setXray(false);assert.equal(batch.material.transparent,false);batches.dispose();
});
test('source line segments batch without turning them into triangles or losing hidden/pick identity',()=>{
 const root=new THREE.Group();root.rotation.x=-Math.PI/2;const mesh=source('nwc:line',true);root.add(mesh);const batches=new ModelBatches(root,new Map([['nwc:line',mesh]]));root.updateMatrixWorld(true);
 const line=root.children.find((o):o is THREE.LineSegments=>o instanceof THREE.LineSegments)!;assert(line);assert.equal(line.geometry.index!.count,2);assert.equal(mesh.geometry.index!.count,0);assert.equal(mesh.parent,batches.proxyRoot);
 const color=line.geometry.getAttribute('color');assert.equal(color.getW(0),1);batches.updateVisibility('nwc:line',false);assert.equal(color.getW(0),0);batches.updateVisibility('nwc:line',true);assert.equal(color.getW(0),1);
 const ray=new THREE.Raycaster(new THREE.Vector3(.5,1,0),new THREE.Vector3(0,-1,0));ray.params.Line.threshold=.01;const hit=ray.intersectObjects(mesh.children,false)[0];assert.equal(hit.object.userData.elementId,'nwc:line');
 batches.update('nwc:line',mesh,true);assert.equal(mesh.parent,root);assert.equal(color.getW(0),0);batches.update('nwc:line',mesh,false);assert.equal(color.getW(0),1);batches.dispose();assert.equal(mesh.parent,root);
});
test('chunk limits keep every instance rather than truncating the large model',()=>{
 const root=new THREE.Group(),sources=new Map<string,SourceMesh>();for(let i=0;i<2050;i++){const mesh=source('synthetic:'+i);root.add(mesh);sources.set(mesh.userData.elementId,mesh);}
 const batches=new ModelBatches(root,sources),parts=root.children.filter((o):o is THREE.BatchedMesh=>o instanceof THREE.BatchedMesh);assert.equal(parts.length,2);assert.equal(parts.reduce((n,p)=>n+p.instanceCount,0),2050);assert.equal(sources.size,2050);batches.dispose();
});
