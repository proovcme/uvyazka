import type {ModelPackage} from './model';
import {elementIdentity} from './element-identity.ts';

type Occurrences=Map<string,Map<string,string[]>>;
const indexes=new WeakMap<ModelPackage,Map<string,Occurrences>>();
/** Join only an explicit Revit ID in the same source revision. Never use STEP IDs or names. */
export function scheduleSceneSelection(model:ModelPackage|null,sourceHash:string,elementIds:string[]){
 const requested=[...new Set(elementIds)],sceneIds:string[]=[],missing:string[]=[],ambiguous:string[]=[];
 let sources=model?indexes.get(model):undefined;
 if(model&&!sources){
  sources=new Map();const members=new Map((model.federation?.members??[]).map(m=>[m.instance_id,m.source_sha256]));
  for(const element of model.elements){
   if(!element.mesh)continue;
   const identity=elementIdentity(element);if(identity.status!=='read'||!identity.element_id)continue;
   const hash=model.federation?members.get(element.source_instance_id??''):model.source.format==='rvt'?model.source.sha256:element.source.file_sha256;
   if(!hash)continue;let ids=sources.get(hash);if(!ids){ids=new Map();sources.set(hash,ids);}
   let occurrences=ids.get(identity.element_id);if(!occurrences){occurrences=new Map();ids.set(identity.element_id,occurrences);}
   const instance=element.source_instance_id??'';occurrences.set(instance,[...(occurrences.get(instance)??[]),element.id]);
  }
  indexes.set(model,sources);
 }
 const ids=sources?.get(sourceHash);
 for(const id of requested){
  const occurrences=ids?.get(id);
  if(!occurrences){missing.push(id);continue;}
  if([...occurrences.values()].some(values=>values.length!==1)){ambiguous.push(id);continue;}
  for(const values of occurrences.values())sceneIds.push(...values);
 }
 return {scene_ids:[...new Set(sceneIds)],requested:requested.length,represented:requested.length-missing.length-ambiguous.length,missing_ids:missing,ambiguous_ids:ambiguous};
}
