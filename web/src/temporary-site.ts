import * as THREE from 'three';
import type { ModelPackage } from './model';
import type { RunPackage, TemporaryAsset } from './simulation';

/** Display proxies for temporary works; never certified structural supports. */
export class TemporarySite {
  readonly group = new THREE.Group();
  readonly objects: {asset:TemporaryAsset; root:THREE.Group; platform:THREE.Vector3|null; valid:boolean;box:THREE.Box3}[] = [];
  readonly states: {id:string;kind:string;phase:string;fraction:number;placementValid:boolean}[]=[];
  readonly geometries: THREE.BufferGeometry[]=[];
  readonly frame = new THREE.LineBasicMaterial({color:0x40788c});
  readonly deck = new THREE.MeshStandardMaterial({color:0xc6a874,roughness:.9});
  constructor(readonly model:ModelPackage, readonly run:RunPackage, readonly occupied:Map<string,THREE.Box3>) {
    const origin=model.coordinate_system.render_origin_m;
    const vec=(p:number[])=>new THREE.Vector3(p[0]-origin[0],p[2]-origin[2],-(p[1]-origin[1]));
    for(const asset of run.scenario.temporary_assets??[]) {
      const a=vec(asset.bounds_m[0]), b=vec(asset.bounds_m[1]);
      const box=new THREE.Box3().setFromPoints([a,b]);
      const root=new THREE.Group(); this.group.add(root);
      let platform:THREE.Vector3|null=null, valid=true;
      if(asset.kind==='facade_scaffold') {
        const lo=box.min,hi=box.max;
        const sides=[[[lo.x-.8,lo.z-.8],[hi.x+.8,lo.z-.8]],[[hi.x+.8,lo.z-.8],[hi.x+.8,hi.z+.8]],
          [[hi.x+.8,hi.z+.8],[lo.x-.8,hi.z+.8]],[[lo.x-.8,hi.z+.8],[lo.x-.8,lo.z-.8]]];
        for(let y=lo.y;y<hi.y;y+=2) for(const [start,end] of sides) {
          const distance=Math.hypot(end[0]-start[0],end[1]-start[1]),count=Math.max(1,Math.ceil(distance/2.5));
          for(let i=0;i<count;i++) {
            const x1=start[0]+(end[0]-start[0])*i/count,z1=start[1]+(end[1]-start[1])*i/count;
            const x2=start[0]+(end[0]-start[0])*(i+1)/count,z2=start[1]+(end[1]-start[1])*(i+1)/count;
            const top=Math.min(y+2,hi.y), bay=new THREE.Group();root.add(bay);
            this.lines(bay,[[x1,y,z1,x1,top,z1],[x2,y,z2,x2,top,z2],[x1,top,z1,x2,top,z2],[x1,y,z1,x2,top,z2],
              [x1,top+.6,z1,x2,top+.6,z2]]);
            const geometry=new THREE.BoxGeometry(Math.abs(x2-x1)>.01?Math.abs(x2-x1):.65,.06,Math.abs(z2-z1)>.01?Math.abs(z2-z1):.65);
            this.geometries.push(geometry);const plank=new THREE.Mesh(geometry,this.deck);plank.position.set((x1+x2)/2,top,(z1+z2)/2);bay.add(plank);
          }
        }
      } else {
        const center=box.getCenter(new THREE.Vector3()), size=box.getSize(new THREE.Vector3());
        const unit=run.scenario.units.find(u=>u.id===asset.unit_id);
        const target=new THREE.Box3(); for(const id of unit?.target_ids??[]) {const shape=occupied.get(id);if(shape)target.union(shape);}
        const baseCandidates=target.isEmpty()?[center.clone()]:[
          new THREE.Vector3(target.min.x-.9,center.y,target.getCenter(new THREE.Vector3()).z),new THREE.Vector3(target.max.x+.9,center.y,target.getCenter(new THREE.Vector3()).z),
          new THREE.Vector3(target.getCenter(new THREE.Vector3()).x,center.y,target.min.z-.8),new THREE.Vector3(target.getCenter(new THREE.Vector3()).x,center.y,target.max.z+.8)];
        const candidates=baseCandidates.flatMap(p=>[p,...[-1.5,-.75,.75,1.5].flatMap(shift=>[
          new THREE.Vector3(p.x+shift,p.y,p.z),new THREE.Vector3(p.x,p.y,p.z+shift)])]);
        const before=run.operation_states[asset.install_id].start;
        const completed=new Set(run.scenario.initial_element_ids??[]);
        for(const u of run.scenario.units) if(run.operation_states[u.operation_ids.at(-1)!].finish<=before) for(const id of u.target_ids)completed.add(id);
        const clear=(p:THREE.Vector3)=> {
          const probe=new THREE.Box3(new THREE.Vector3(p.x-.65,box.min.y+.1,p.z-.45),new THREE.Vector3(p.x+.65,box.max.y+1.5,p.z+.45));
          const supported=Math.abs(box.min.y)<.05||model.elements.some(e=>e.hierarchy.includes('IfcSlab')&&completed.has(e.id)&&(()=>{
            const floor=occupied.get(e.id);return floor&&Math.abs(floor.max.y-box.min.y)<.2&&
              p.x-.65>=floor.min.x&&p.x+.65<=floor.max.x&&p.z-.45>=floor.min.z&&p.z+.45<=floor.max.z;})());
          return supported&&![...completed,...unit?.target_ids??[]].some(id=>{const other=occupied.get(id);return other && other.max.y>box.min.y+.2 && other.intersectsBox(probe);});
        };
        const safe=candidates.find(clear);valid=Boolean(safe);
        const position=safe??center;root.position.set(position.x,box.min.y,position.z);
        const height=Math.max(1,size.y), points:number[][]=[];
        for(const x of [-.65,.65]) for(const z of [-.45,.45]) points.push([x,0,z,x,height+1,z]);
        for(let y=0;y<=height+.01;y+=.5) points.push([-.65,y,-.45,.65,y,-.45],[-.65,y,.45,.65,y,.45]);
        points.push([-.65,0,-.45,.65,height,-.45],[.65,0,.45,-.65,height,.45],[-.65,height+1,-.45,.65,height+1,-.45],[-.65,height+1,.45,.65,height+1,.45]);
        this.lines(root,points);
        const geometry=new THREE.BoxGeometry(1.3,.07,.9);this.geometries.push(geometry);
        const plank=new THREE.Mesh(geometry,this.deck);plank.position.y=height;root.add(plank);
        platform=new THREE.Vector3(position.x,box.min.y+height+.04,position.z);
      }
      this.objects.push({asset,root,platform,valid,box});
    }
  }
  private lines(root:THREE.Group,segments:number[][]) {
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(segments.flat(),3));
    this.geometries.push(geometry);root.add(new THREE.LineSegments(geometry,this.frame));
  }
  update(tick:number) {
    this.states.length=0;
    for(const object of this.objects) {
      const {asset,root,valid}=object, install=this.run.operation_states[asset.install_id], check=this.run.operation_states[asset.check_id], remove=this.run.operation_states[asset.remove_id];
      const fraction=tick<install.start||tick>=remove.finish?0:tick<install.finish?(tick-install.start)/(install.finish-install.start):tick>=remove.start?1-(tick-remove.start)/(remove.finish-remove.start):1;
      root.visible=valid&&fraction>0;
      if(asset.kind==='facade_scaffold') root.children.forEach((child,index)=>child.visible=index<Math.ceil(root.children.length*fraction));
      if(fraction>0) this.states.push({id:asset.id,kind:asset.kind,fraction,placementValid:valid,
        phase:tick<install.finish?'сборка':tick<check.finish?'ожидание приёмки':tick>=remove.start?'разборка':'готово к работе'});
    }
  }
  platformFor(operationId:string,tick:number) {
    const object=this.objects.find(o=>o.valid&&o.asset.work_operation_ids.includes(operationId)&&
      this.run.operation_states[o.asset.check_id].finish<=tick&&tick<this.run.operation_states[o.asset.remove_id].start);
    if(!object)return null;
    if(object.platform)return object.platform;
    const operation=this.run.scenario.operations.find(o=>o.id===operationId), target=new THREE.Box3();
    for(const id of operation?.target_ids??[]) {const box=this.occupied.get(id);if(box)target.union(box);}
    if(target.isEmpty())return null;
    const center=target.getCenter(new THREE.Vector3()), lo=object.box.min,hi=object.box.max;
    const candidates=[new THREE.Vector3(lo.x-.8,0,center.z),new THREE.Vector3(hi.x+.8,0,center.z),new THREE.Vector3(center.x,0,lo.z-.8),new THREE.Vector3(center.x,0,hi.z+.8)];
    const point=candidates.sort((a,b)=>a.distanceToSquared(center)-b.distanceToSquared(center))[0];
    point.y=Math.min(hi.y,lo.y+Math.max(2,Math.round((center.y-lo.y)/2)*2))+.04;return point;
  }
  dispose() {this.group.removeFromParent();this.geometries.forEach(g=>g.dispose());this.frame.dispose();this.deck.dispose();}
}
