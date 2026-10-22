import type {ModelPackage} from './model.ts';

export function systemMembers(model:ModelPackage|null,id:string):Set<string>{
  return new Set(model?.systems?.find(system=>system.id===id)?.member_ids??[]);
}
export function systemCoverage(model:ModelPackage,id:string){
  const ids=systemMembers(model,id),elements=new Map(model.elements.map(e=>[e.id,e]));
  let present=0,geometry=0;
  for(const id of ids){const element=elements.get(id);if(element){present++;if(element.mesh)geometry++;}}
  return {declared:ids.size,present,geometry,missing:ids.size-present,withoutGeometry:present-geometry};
}
export function elementSystems(model:ModelPackage|null,id:string){
  return (model?.systems??[]).filter(system=>system.member_ids.includes(id));
}
