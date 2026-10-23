import type {BimElement,ModelPackage} from './model';

export function elementIdentity(element:BimElement){
  const direct=element.revit?.element_id;
  if(direct&&/^\d+$/.test(String(direct)))return {element_id:String(direct),unique_id:element.revit?.unique_id||null,
    basis:({'ifc_tag_revit_export':'Tag в IFC, экспортированном из Revit','rvt_converter_tag':'RVT ElementId, сохранённый конвертером'} as Record<string,string>)[element.revit?.id_basis||'']||element.revit?.id_basis||'Прочитанный Revit ElementId',status:'read'};
  const candidates=new Set<string>();let unique:string|null=null;
  for(const [set,fields] of Object.entries(element.property_sets??{}))for(const [key,value] of Object.entries(fields)){
    if((/^(Revit ?Element ?I[dD]|Revit ?I[dD])$/.test(key)||/revit/i.test(set)&&/^Element ?I[dD]$/.test(key))&&/^\d+$/.test(String(value)))candidates.add(String(value));
    if(/revit/i.test(set)&&/^(UniqueId|Unique ID)$/i.test(key)&&typeof value==='string')unique=value;
  }
  return {element_id:candidates.size===1?[...candidates][0]:null,unique_id:unique,
    basis:candidates.size>1?'Противоречащие Revit ID в свойствах':candidates.size?'Явный параметр ElementId':'Revit ElementId не прочитан',status:candidates.size>1?'conflict':candidates.size?'read':'unavailable'};
}
// Records belong to an immutable model revision. Never serialize all properties again per keystroke.
const recordText=new WeakMap<object,string>();
function searchableText(record:object){let text=recordText.get(record);if(text===undefined){text=JSON.stringify(record).toLocaleLowerCase();recordText.set(record,text);}return text;}
export function matchesDataQuery(record:Record<string,unknown>,query:string){
  const q=query.trim().toLocaleLowerCase();if(!q)return true;
  const exact=/^revit\s*:\s*(\d+)$/.exec(q);
  if(exact){const identity=record.revit_identity as {element_id?:string}|undefined;const revit=record.revit as {element_id?:string}|undefined;return String(identity?.element_id??revit?.element_id??'')===exact[1];}
  const text=searchableText(record);return q.split(/\s+/).every(part=>text.includes(part));
}
const indexes=new WeakMap<ModelPackage,Map<string,string>>();
export function elementMatches(element:BimElement,model:ModelPackage,query:string){
  if(!query.trim())return true;
  const exact=/^revit\s*:\s*(\d+)$/i.exec(query.trim());if(exact)return elementIdentity(element).element_id===exact[1];
  let index=indexes.get(model);
  if(!index){
    const systems=new Map<string,string[]>();for(const s of model.systems??[])for(const id of s.member_ids)systems.set(id,[...(systems.get(id)??[]),s.name,s.id]);
    const levels=new Map(model.storeys.map(s=>[s.id,s.name]));
    index=new Map(model.elements.map(e=>{const {mesh,...properties}=e;return [e.id,JSON.stringify({properties,revit_identity:elementIdentity(e),systems:systems.get(e.id),level:levels.get(e.storey_id??'')}).toLocaleLowerCase()];}));indexes.set(model,index);
  }
  return query.toLocaleLowerCase().trim().split(/\s+/).every(part=>index!.get(element.id)?.includes(part));
}
