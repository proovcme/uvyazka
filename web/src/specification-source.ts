import type {SpecDataset} from './model-specification';
import type {ValueCell} from './rvt-schedule';
import {elementIdentity} from './element-identity.ts';
/** Labels only; never creates or changes a parameter value or correspondence. */
export function specificationSourceContext(dataset:SpecDataset,keys:string[],cell:ValueCell,parameterSourceHash?:string){
 const wanted=new Set(keys),rows=dataset.rows.filter(r=>wanted.has(r.key)),sources:string[]=[],owners:{label:string;id:string}[]=[],valueOwners=new Set(cell.evidence.map(e=>e.owner_id));
 const members=new Map((dataset.model?.federation?.members??[]).map(m=>[m.instance_id,m.label]));
 for(const row of rows){
  const file=row.document?.source?.filename??members.get(row.element?.source_instance_id??'')??dataset.model?.source.filename;
  if(file)sources.push(file);
  const revit=row.native?.identity.element_id??(row.element?elementIdentity(row.element).element_id:null);
  if(revit!==null&&revit!==undefined)owners.push({label:'Элемент строки · Revit ID'+(file?' · '+file:''),id:String(revit)});
  else if(row.element?.global_id)owners.push({label:'Элемент строки · IFC GlobalId'+(file?' · '+file:''),id:row.element.global_id});
  else if(row.scene_id)owners.push({label:'Элемент строки · ID сцены',id:row.scene_id});
  const type=row.type?.identity.element_id;if(parameterSourceHash===row.source_sha256&&type!==undefined&&valueOwners.has(String(type)))owners.push({label:'Источник значения · Revit ID типа'+(file?' · '+file:''),id:String(type)});
 }
 return {sources,owners};
}
