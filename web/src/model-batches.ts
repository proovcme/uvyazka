import * as THREE from 'three';

export type SourceMesh=THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial[]>;
interface Part {id:string;mesh:SourceMesh;style:number;start:number;count:number;vertices:number}
interface Slot {batch:THREE.BatchedMesh;instance:number;style:number;visible:boolean}
interface Bucket {mesh:THREE.BatchedMesh;transparent:boolean}
interface LineBucket {mesh:THREE.LineSegments;transparent:boolean}
interface LineSlot {color:THREE.BufferAttribute;start:number;count:number;visible:boolean}
/** Presentation only. Original meshes remain exact pick/measurement/simulation proxies.
 * Their geometry, group indices and source IDs are never rewritten by batching. */
export class ModelBatches {
 readonly proxyRoot=new THREE.Group();
 private slots=new Map<string,Slot[]>();
 private buckets:Bucket[]=[];
 private lineBuckets:LineBucket[]=[];
 private lineSlots=new Map<string,LineSlot>();
 private promoted=new Set<string>();
 private enabled=true;
 private color=new THREE.Vector4();
 private root:THREE.Group;
 private sources:Map<string,SourceMesh>;
 constructor(root:THREE.Group,sources:Map<string,SourceMesh>){
  this.root=root;this.sources=sources;
  this.proxyRoot.rotation.copy(root.rotation);this.proxyRoot.position.copy(root.position);this.proxyRoot.scale.copy(root.scale);
  const chunks:Part[][]=[];let chunk:Part[]=[],vertices=0,indices=0;
  const flush=()=>{if(chunk.length)chunks.push(chunk);chunk=[];vertices=0;indices=0;};
  // Bound each allocation, without dropping a large individual geometry.
  for(const [id,mesh]of sources){
   if(mesh.userData.sourcePrimitive==='lines'||mesh.userData.role!=='element')continue;
   const geometry=mesh.geometry,index=geometry.index;if(!index?.count)continue;
   const groups=geometry.groups.length?geometry.groups:[{start:0,count:index.count,materialIndex:0}];
   for(const group of groups){if(!group.count)continue;
    if(!mesh.material[group.materialIndex??0])throw Error('Missing batch material');
    const n=geometry.getAttribute('position').count;
    if(chunk.length&&(chunk.length>=2048||vertices+n>500_000||indices+group.count>1_500_000))flush();
    chunk.push({id,mesh,style:group.materialIndex??0,start:group.start,count:group.count,vertices:n});vertices+=n;indices+=group.count;
   }
  }flush();
  try{
   for(const parts of chunks){
    // Separate opaque/transparent surfaces so normal mode retains depth semantics.
    for(const transparent of [false,true]){
     const rows=parts.filter(p=>p.mesh.material[p.style].transparent===transparent);if(!rows.length)continue;
     const material=new THREE.MeshStandardMaterial({color:0xffffff,side:THREE.DoubleSide,roughness:.85,metalness:.02,flatShading:true,transparent,depthWrite:!transparent});
     const batch=new THREE.BatchedMesh(rows.length,rows.reduce((n,p)=>n+p.vertices,0),rows.reduce((n,p)=>n+p.count,0),material);
     batch.sortObjects=transparent;batch.perObjectFrustumCulled=true;batch.frustumCulled=false;batch.receiveShadow=true;
     this.buckets.push({mesh:batch,transparent});
     for(const part of rows){
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',part.mesh.geometry.getAttribute('position'));
      geometry.setIndex(new THREE.BufferAttribute((part.mesh.geometry.index!.array as Uint32Array).subarray(part.start,part.start+part.count),1));
      const instance=batch.addInstance(batch.addGeometry(geometry)),slots=this.slots.get(part.id)??[];
      slots.push({batch,instance,style:part.style,visible:true});this.slots.set(part.id,slots);
      const material=part.mesh.material[part.style];this.color.set(material.color.r,material.color.g,material.color.b,material.opacity);batch.setColorAt(instance,this.color);
     }
     root.add(batch);
    }
   }
   this.buildLines();
   for(const id of this.ids())this.proxyRoot.add(sources.get(id)!);
   this.proxyRoot.updateMatrixWorld(true);
  }catch(error){this.dispose();throw error;}
 }
 private ids(){return new Set([...this.slots.keys(),...this.lineSlots.keys()]);}
 private buildLines(){
  const lines=[...this.sources].flatMap(([id,mesh])=>mesh.userData.sourcePrimitive==='lines'?mesh.children.filter((c):c is THREE.LineSegments=>c instanceof THREE.LineSegments&&c.userData.sourceLines).map(line=>({id,mesh,line})):[]);
  for(const transparent of [false,true]){
   const rows=lines.filter(({line})=>(line.material as THREE.LineBasicMaterial).transparent===transparent);if(!rows.length)continue;
   // Lines are already independent segment indices, no inferred connectivity.
   const vertices=rows.reduce((n,r)=>n+r.line.geometry.getAttribute('position').count,0),count=rows.reduce((n,r)=>n+(r.line.geometry.index?.count??0),0);
   const positions=new Float32Array(vertices*3),colors=new Float32Array(vertices*4),indices=new Uint32Array(count),attribute=new THREE.BufferAttribute(colors,4);
   let offset=0,at=0;
   for(const row of rows){const position=row.line.geometry.getAttribute('position'),index=row.line.geometry.index!;positions.set(position.array as Float32Array,offset*3);for(let i=0;i<index.count;i++)indices[at++]=index.getX(i)+offset;
    const material=row.mesh.material[0];for(let i=offset;i<offset+position.count;i++)attribute.setXYZW(i,material.color.r,material.color.g,material.color.b,material.opacity);
    this.lineSlots.set(row.id,{color:attribute,start:offset,count:position.count,visible:true});offset+=position.count;
   }
   const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('color',attribute);geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeBoundingSphere();
   const material=new THREE.LineBasicMaterial({vertexColors:true,transparent,depthWrite:!transparent,alphaTest:1e-20});const mesh=new THREE.LineSegments(geometry,material);this.lineBuckets.push({mesh,transparent});this.root.add(mesh);
  }
 }
 get count(){return this.buckets.length+this.lineBuckets.length;}
 updateVisibility(id:string,visible:boolean){const show=this.enabled&&!this.promoted.has(id)&&visible;for(const slot of this.slots.get(id)??[]){if(slot.visible!==show){slot.batch.setVisibleAt(slot.instance,show);slot.visible=show;}}const line=this.lineSlots.get(id);if(line&&line.visible!==show){line.visible=show;const alpha=show?this.sources.get(id)!.material[0].opacity:0;for(let i=line.start;i<line.start+line.count;i++)line.color.setW(i,alpha);line.color.addUpdateRange(line.start*4,line.count*4);line.color.needsUpdate=true;}}
 update(id:string,mesh:SourceMesh,emphasized:boolean){
  const slots=this.slots.get(id)??[],line=this.lineSlots.get(id);if(!slots.length&&!line)return;
  if(emphasized)this.promoted.add(id);else this.promoted.delete(id);
  const parent=!this.enabled||emphasized?this.root:this.proxyRoot;if(mesh.parent!==parent){parent.add(mesh);mesh.updateWorldMatrix(true,false);}
  this.updateVisibility(id,mesh.visible);
  for(const slot of slots){const material=mesh.material[slot.style];this.color.set(material.color.r,material.color.g,material.color.b,material.opacity);slot.batch.setColorAt(slot.instance,this.color);}
  if(line){const material=mesh.material[0];for(let i=line.start;i<line.start+line.count;i++)line.color.setXYZW(i,material.color.r,material.color.g,material.color.b,line.visible?material.opacity:0);line.color.addUpdateRange(line.start*4,line.count*4);line.color.needsUpdate=true;}
 }
 setXray(active:boolean){for(const bucket of [...this.buckets,...this.lineBuckets]){const transparent=active||bucket.transparent,material=bucket.mesh.material as THREE.Material;if(material.transparent!==transparent){material.transparent=transparent;material.depthWrite=!transparent;material.needsUpdate=true;}if(bucket.mesh instanceof THREE.BatchedMesh)bucket.mesh.sortObjects=transparent;}}
 setEnabled(enabled:boolean){if(this.enabled===enabled)return;this.enabled=enabled;for(const bucket of [...this.buckets,...this.lineBuckets])bucket.mesh.visible=enabled;
  for(const id of this.ids()){const mesh=this.sources.get(id)!;const parent=!enabled||this.promoted.has(id)?this.root:this.proxyRoot;parent.add(mesh);this.updateVisibility(id,mesh.visible);}this.proxyRoot.updateMatrixWorld(true);
 }
 clip(planes:THREE.Plane[]){for(const bucket of [...this.buckets,...this.lineBuckets]){const m=bucket.mesh.material as THREE.Material;m.clippingPlanes=planes;m.clipShadows=true;m.needsUpdate=true;}}
 dispose(){for(const id of this.ids()){const mesh=this.sources.get(id);if(mesh&&mesh.parent===this.proxyRoot)this.root.add(mesh);}for(const {mesh}of this.buckets){this.root.remove(mesh);mesh.dispose();(mesh.material as THREE.Material).dispose();}for(const {mesh}of this.lineBuckets){this.root.remove(mesh);mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}this.slots.clear();this.lineSlots.clear();this.buckets=[];this.lineBuckets=[];this.promoted.clear();this.proxyRoot.clear();}
}
