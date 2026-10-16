import type { ModelPackage } from './model';
import type { RunPackage } from './simulation';

export interface WorkScene { title:string; kind:string; start:number; end:number; operationId?:string;
  targetIds:string[]; cut?:number; reference?:boolean }

/** Choose real intervals from the event log. Camera work never generates work events. */
export function workScenes(run:RunPackage,model:ModelPackage):WorkScene[] {
  const groups=new Map<string,typeof run.scenario.operations>();
  for(const op of run.scenario.operations) {const values=groups.get(op.kind)??[];values.push(op);groups.set(op.kind,values);}
  const scenes:WorkScene[]=[];
  for(const [kind,group] of groups) {
    const selected=group.length>8?[group[0],group[Math.floor(group.length/2)]]:[group[0]];
    for(const operation of selected) {
      const state=run.operation_states[operation.id];
      const asset=run.scenario.temporary_assets?.find(a=>a.install_id===operation.id||a.check_id===operation.id||a.remove_id===operation.id);
      const targets=operation.target_ids.length?operation.target_ids:asset?.unit_id?run.scenario.units.find(u=>u.id===asset.unit_id)?.target_ids??[]:[];
      const meshes=model.elements.filter(e=>targets.includes(e.id)&&e.mesh);
      const engineering=kind.startsWith('mep_')||['duct_install','pipe_install','cable_install','commissioning'].includes(kind);
      scenes.push({title:operation.name+(kind==='curing'?' · календарное ожидание сжато':''),kind,
        start:state.start+operation.duration*.18,end:state.start+operation.duration*.82,operationId:operation.id,targetIds:targets,
        cut:engineering&&meshes.length?Math.max(...meshes.map(e=>e.mesh!.bbox_max_m[2]))-model.coordinate_system.render_origin_m[2]+.5:undefined});
    }
  }
  scenes.sort((a,b)=>a.start-b.start||a.end-b.end);
  for(let i=0;i<scenes.length-1;i++)scenes[i].end=Math.min(scenes[i].end,scenes[i+1].start);
  scenes.push({title:'Полная сводная модель · включая объекты вне графика',kind:'reference',start:run.duration,end:run.duration,targetIds:[],reference:true});
  const occupied=new Set(model.elements.filter(e=>e.hierarchy.includes('IfcFurnishingElement')).map(e=>e.storey_id));
  const levels=model.storeys.filter(s=>occupied.has(s.id)&&s.elevation_m!==null).sort((a,b)=>b.elevation_m!-a.elevation_m!);
  for(const level of levels.slice(0,3))scenes.push({title:'Интерьер · '+level.name+' · исходные элементы',kind:'interior',start:run.duration,end:run.duration,
    targetIds:[],reference:true,cut:level.elevation_m!-model.coordinate_system.render_origin_m[2]+1.25});
  return scenes;
}
