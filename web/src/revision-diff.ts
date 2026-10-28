import type {BimElement,ModelPackage} from './model';
import {elementIdentity} from './element-identity.ts';
const stable=(v:unknown):string=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+stable(x)).join(',')+'}':JSON.stringify(v)??'null';
function identity(e:BimElement){const r=elementIdentity(e);return r.unique_id?'revit-unique:'+r.unique_id:e.global_id?'ifc-global:'+e.global_id:r.element_id?'revit-id:'+r.element_id:null;}
export function compareRevisions(before:ModelPackage,after:ModelPackage,sameLineage:boolean){
 if(!sameLineage)throw Error('Подтвердите, что это ревизии одной модели, с одинаковым размещением.');
 const index=(model:ModelPackage)=>{const map=new Map<string,BimElement[]>();for(const e of model.elements.filter(e=>e.role==='element')){const k=identity(e);if(k){const rows=map.get(k)??[];rows.push(e);map.set(k,rows);}}return map;};
 const a=index(before),b=index(after),rows:{kind:'added'|'removed'|'changed'|'question';key:string;before_id?:string;after_id?:string;name:string;changes:string[]}[]=[];
 for(const key of new Set([...a.keys(),...b.keys()])){
  const aa=a.get(key)??[],bb=b.get(key)??[],old=aa[0],next=bb[0];
  if(aa.length>1||bb.length>1){rows.push({kind:'question',key,name:next?.name??old?.name??key,changes:['Неоднозначный идентификатор: '+aa.length+' → '+bb.length]});continue;}
  if(!old||!next){rows.push({kind:old?'removed':'added',key,before_id:old?.id,after_id:next?.id,name:(next??old).name,changes:[]});continue;}
  const changes:string[]=[];
  for(const field of ['name','class','predefined_type','materials','property_sets','quantity_sets']as const)if(stable(old[field])!==stable(next[field]))changes.push(field);
  if(!!old.mesh!==!!next.mesh)changes.push('geometry_availability');
  else if(old.mesh&&next.mesh){const x=[...old.mesh.bbox_min_m,...old.mesh.bbox_max_m],y=[...next.mesh.bbox_min_m,...next.mesh.bbox_max_m];if(x.some((n,i)=>Math.abs(n-y[i])>.001))changes.push('bounding_box_m');}
  if(changes.length)rows.push({kind:'changed',key,before_id:old.id,after_id:next.id,name:next.name,changes});
 }
 for(const [model,side]of [[before,'before'],[after,'after']]as const)for(const e of model.elements.filter(e=>e.role==='element'&&!identity(e)))rows.push({kind:'question',key:side+':'+e.id,name:e.name,changes:['Устойчивый идентификатор не прочитан'],...(side==='before'?{before_id:e.id}:{after_id:e.id})});
 return {contract:'RevisionComparison',version:1,before:{model_id:before.model_id,sha256:before.source.sha256},after:{model_id:after.model_id,sha256:after.source.sha256},basis:'explicit_identity_same_lineage_confirmed_by_user',limitations:'Сравниваются прочитанные наборы. Отсутствие элемента в неполной выгрузке не доказывает удаление из исходного проекта. Габариты сравниваются с допуском 1 мм. Изменение габаритов не отличает перенос от изменения формы; равные габариты не доказывают равную геометрию. Идентификаторы и STEP номера не сопоставляются по именам.',rows};
}
