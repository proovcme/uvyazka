import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {ModelPicking} from '../src/model-picking.ts';

function triangle(x=0,z=0){
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([x,0,z,x+1,0,z,x,1,z],3));g.setIndex([0,1,2]);
 const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld();return mesh;
}
function same(a:THREE.Intersection|undefined,b:THREE.Intersection|undefined){assert.equal(a?.object,b?.object);assert.equal(a?.faceIndex,b?.faceIndex);assert.deepEqual(a?.point.toArray(),b?.point.toArray());}
test('broad phase returns the same original triangle, point and tie order across transformed objects',()=>{
 const parent=new THREE.Group();parent.rotation.y=.35;parent.position.set(3,2,-4);
 const objects=Array.from({length:220},(_,i)=>triangle(i*3));objects[1]=triangle();objects.forEach(o=>parent.add(o));parent.updateMatrixWorld(true);
 const index=new ModelPicking(objects),center=new THREE.Vector3(.2,.2,0).applyMatrix4(objects[0].matrixWorld),normal=new THREE.Vector3(0,0,1).transformDirection(objects[0].matrixWorld);
 const ray=new THREE.Raycaster(center.clone().addScaledVector(normal,10),normal.negate());
 same(index.pick(ray),ray.intersectObjects(objects,false)[0]);assert.equal(index.pick(ray)?.object,objects[0]);assert.ok(index.tested<objects.length/10);
 objects[0].visible=false;same(index.pick(ray,o=>o.visible),ray.intersectObjects(objects.filter(o=>o.visible),false)[0]);
});
test('clipping rejects a nearer surface and still finds the exact farther hit; near and far remain respected',()=>{
 const objects=[triangle(0,5),triangle(0,0)],index=new ModelPicking(objects),ray=new THREE.Raycaster(new THREE.Vector3(.2,.2,10),new THREE.Vector3(0,0,-1));
 const accept=(hit:THREE.Intersection)=>hit.point.z<1;
 same(index.pick(ray,undefined,accept),ray.intersectObjects(objects,false).find(accept));ray.far=7;assert.equal(index.pick(ray,undefined,accept),undefined);
 ray.far=Infinity;ray.near=6;same(index.pick(ray),ray.intersectObjects(objects,false)[0]);index.clear();assert.equal(index.pick(ray),undefined);
});
test('line tolerance and visibility work without converting original line segments into triangles',()=>{
 const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(2,0,0)]),line=new THREE.LineSegments(g,new THREE.LineBasicMaterial());
 const objects=[triangle(30),line],index=new ModelPicking(objects),ray=new THREE.Raycaster(new THREE.Vector3(1,.15,3),new THREE.Vector3(0,0,-1));ray.params.Line.threshold=.2;
 same(index.pick(ray),ray.intersectObjects(objects,false)[0]);assert.equal(index.pick(ray)?.object,line);
 line.visible=false;assert.equal(index.pick(ray,o=>o.visible),undefined);line.visible=true;ray.params.Line.threshold=.01;assert.equal(index.pick(ray),undefined);
});
