import type {BimElement,ModelPackage} from './model';
const explicitId=(value:unknown)=>typeof value==='string'&&/^\d+$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):null;

export function elementIdentity(element:BimElement){
  const direct=explicitId(element.revit?.element_id);
  if(direct!==null)return {element_id:direct,unique_id:element.revit?.unique_id||null,
    basis:({'ifc_tag_revit_export':'Tag в IFC, экспортированном из Revit','rvt_converter_tag':'RVT ElementId, сохранённый конвертером','rvt_native_identity':'Исходная таблица идентификаторов RVT'} as Record<string,string>)[element.revit?.id_basis||'']||element.revit?.id_basis||'Прочитанный Revit ElementId',status:'read'};
  const candidates=new Set<string>();let unique:string|null=null;
  for(const [set,fields] of Object.entries(element.property_sets??{}))for(const [key,value] of Object.entries(fields)){
    const id=explicitId(value);if((/^(Revit ?Element ?I[dD]|Revit ?I[dD])$/.test(key)||/revit/i.test(set)&&/^Element ?I[dD]$/.test(key))&&id!==null)candidates.add(id);
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
const labels=new WeakMap<BimElement,string>();
/** Element finder: names/types and identities, without matches from unrelated quantity values. */
export function elementLabelMatches(element:BimElement,query:string){
  const q=query.trim().toLocaleLowerCase();if(!q)return true;
  const revit=/^revit\s*:\s*(\d+)$/.exec(q);if(revit)return elementIdentity(element).element_id===revit[1];
  if(q.startsWith('#'))return element.id.toLocaleLowerCase()===q.slice(1)||String(element.step_id)===q.slice(1);
  let text=labels.get(element);
  if(text===undefined){
    const familyTypes:unknown[]=[];
    for(const fields of Object.values(element.property_sets??{}))for(const [key,value] of Object.entries(fields))if(/family|семейство|^тип(?:оразмер)?$|^type(?: name)?$|typename/i.test(key))familyTypes.push(value);
    const identity=elementIdentity(element);
    text=[element.name,element.long_name,element.class,element.id,element.step_id,element.global_id,element.tag,identity.element_id,identity.unique_id,...familyTypes].map(v=>v==null?'':typeof v==='object'?JSON.stringify(v):String(v)).join(' ').toLocaleLowerCase();labels.set(element,text);
  }
  return q.split(/\s+/).every(part=>text!.includes(part));
}
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
