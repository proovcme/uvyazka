import type {BimElement,ModelPackage} from './model';
import {elementIdentity} from './element-identity.ts';
export type ParameterOperator='contains'|'equals'|'exists'|'missing'|'gt'|'gte'|'lt'|'lte';
export interface ParameterFilter {name:string;value:string;operator:ParameterOperator}
interface Parameter {name:string;value:unknown}
const records=new WeakMap<BimElement,Parameter[]>(),catalogs=new WeakMap<ModelPackage,string[]>();
function parameters(element:BimElement){
  let entries=records.get(element);if(entries)return entries;
  entries=[];
  const add=(name:string,value:unknown)=>entries!.push({name,value});
  const walk=(value:unknown,path:string[])=>{
    if(value!==null&&typeof value==='object'&&!Array.isArray(value)){for(const [key,next] of Object.entries(value))walk(next,[...path,key]);}
    else add(path.join(' · '),value);
  };
  walk(element.property_sets??{},['Свойства']);walk(element.quantity_sets??{},['Количества']);walk(element.source_quantities??{},['Величины из источника']);
  add('Revit ElementId',elementIdentity(element).element_id);add('IFC GlobalId',element.global_id);add('ID сцены',element.id);
  add('Наименование',element.name);add('Класс IFC',element.class);add('Материалы',element.materials);
  records.set(element,entries);return entries;
}
export function parameterCatalog(model:ModelPackage){let result=catalogs.get(model);if(!result){result=[...new Set(model.elements.filter(e=>e.role==='element').flatMap(e=>parameters(e).map(p=>p.name)))].sort((a,b)=>a.localeCompare(b,'ru'));catalogs.set(model,result);}return result;}
export function parameterMatches(element:BimElement,filter:ParameterFilter){
  const name=filter.name.trim().toLocaleLowerCase();if(!name)return true;
  const selected=parameters(element).filter(p=>p.name.toLocaleLowerCase().includes(name));
  const present=selected.filter(p=>p.value!==null&&p.value!==undefined&&(typeof p.value!=='string'||p.value.trim()!==''));
  if(filter.operator==='exists')return present.length>0;
  if(filter.operator==='missing')return present.length===0;
  const wanted=filter.value.trim().toLocaleLowerCase();
  if(['gt','gte','lt','lte'].includes(filter.operator)){
    if(!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(wanted))return false;
    const threshold=Number(wanted.replace(',','.'));
    if(!Number.isFinite(threshold)||Number.isInteger(threshold)&&!Number.isSafeInteger(threshold))return false;
    return present.some(p=>{const value=typeof p.value==='number'?p.value:typeof p.value==='string'&&/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(p.value.trim())?Number(p.value.replace(',','.')):NaN;
      return Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value))&&(filter.operator==='gt'?value>threshold:filter.operator==='gte'?value>=threshold:filter.operator==='lt'?value<threshold:value<=threshold);});
  }
  return present.some(p=>{const value=(typeof p.value==='string'?p.value:JSON.stringify(p.value)).toLocaleLowerCase();return filter.operator==='equals'?value===wanted:value.includes(wanted);});
}
