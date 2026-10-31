import * as THREE from 'three';

interface Entry {object:THREE.Object3D;box:THREE.Box3;order:number}
interface Node {box:THREE.Box3;entries?:Entry[];left?:Node;right?:Node}
/** Object-level broad phase only. Three.js still computes the exact source
 * triangle/line hit, face indices and measurement point. No simplified mesh. */
export class ModelPicking {
 private root?:Node;
 private fallback:Entry[]=[];
 tested=0;
 candidates=0;
 total=0;
 constructor(objects:THREE.Object3D[]=[]){this.build(objects);}
 build(objects:THREE.Object3D[]){
  this.fallback=[];this.total=objects.length;
  const entries:Entry[]=[];
  objects.forEach((object,order)=>{
   object.updateWorldMatrix(true,false);
   const geometry=(object as THREE.Mesh).geometry;
   if(geometry&&!geometry.boundingBox)geometry.computeBoundingBox();
   const box=geometry?.boundingBox?.clone().applyMatrix4(object.matrixWorld);
   if(box&&!box.isEmpty()&&[...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))entries.push({object,box,order});
   else this.fallback.push({object,box:new THREE.Box3(),order});
  });
  const split=(rows:Entry[]):Node=>{
   const box=new THREE.Box3();for(const row of rows)box.union(row.box);
   if(rows.length<=16)return {box,entries:rows};
   const size=box.getSize(new THREE.Vector3()),axis=size.x>=size.y&&size.x>=size.z?'x':size.y>=size.z?'y':'z';
   rows.sort((a,b)=>(a.box.min[axis]+a.box.max[axis])-(b.box.min[axis]+b.box.max[axis])||a.order-b.order);
   const mid=Math.floor(rows.length/2);return {box,left:split(rows.slice(0,mid)),right:split(rows.slice(mid))};
  };
  this.root=entries.length?split(entries):undefined;
 }
 pick(raycaster:THREE.Raycaster,visible:(object:THREE.Object3D)=>boolean=object=>object.visible,accept:(hit:THREE.Intersection)=>boolean=()=>true):THREE.Intersection|undefined{
  this.tested=0;this.candidates=0;
  // Lines use a world-space tolerance; expanding all broad-phase boxes is
  // conservative and cannot remove a triangle candidate.
  const padding=Math.max(0,raycaster.params.Line?.threshold??0),ray=raycaster.ray;
  const distance=(box:THREE.Box3)=>{
   let near=Math.max(0,raycaster.near),far=raycaster.far;
   for(const axis of ['x','y','z']as const){
    const d=ray.direction[axis],o=ray.origin[axis],low=box.min[axis]-padding,high=box.max[axis]+padding;
    if(d===0){if(o<low||o>high)return Infinity;continue;}
    const a=(low-o)/d,b=(high-o)/d;near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));if(near>far)return Infinity;
   }return near;
  };
  const candidates:{entry:Entry;distance:number}[]=this.fallback.map(entry=>({entry,distance:0}));
  const stack=this.root?[this.root]:[];
  while(stack.length){const node=stack.pop()!;if(distance(node.box)===Infinity)continue;
   if(node.entries){for(const entry of node.entries){const d=distance(entry.box);if(d!==Infinity)candidates.push({entry,distance:d});}}
   else {stack.push(node.left!,node.right!);}
  }
  candidates.sort((a,b)=>a.distance-b.distance||a.entry.order-b.entry.order);this.candidates=candidates.length;
  let best:THREE.Intersection|undefined,order=Infinity;
  for(const row of candidates){
   if(best&&row.distance>best.distance)break;
   if(!visible(row.entry.object))continue;this.tested++;
   const hits=raycaster.intersectObject(row.entry.object,false);
   for(const hit of hits)if(accept(hit)){
    if(!best||hit.distance<best.distance||hit.distance===best.distance&&row.entry.order<order){best=hit;order=row.entry.order;}break;
   }
  }return best;
 }
 clear(){this.root=undefined;this.fallback=[];this.total=0;}
}
