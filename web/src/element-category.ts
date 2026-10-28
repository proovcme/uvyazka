import type {BimElement,ModelPackage} from './model';
import {isNavisFormat} from './navis-format.ts';
/** Source-native category. IFC exports from Revit still use IFC classes. */
export function elementCategory(element:BimElement,model:ModelPackage){
  const member=model.federation?.members.find(m=>m.instance_id===element.source_instance_id);
  if(isNavisFormat(model.source.format)||isNavisFormat(member?.source_format))return {key:JSON.stringify(['nwd',element.nwd?.category_name||element.class]),name:element.nwd?.category_name||element.class,format:(member?.source_format??model.source.format)!.toUpperCase()};
  const rvt=model.source.format==='rvt'||member?.source_format==='rvt'||element.revit?.id_basis==='rvt_converter_tag';
  if(!rvt)return {key:JSON.stringify(['ifc',element.class]),name:element.class,format:'IFC'};
  const value=element.property_sets?.Other?.Category;
  const name=typeof value==='string'&&value.trim()?value.trim():'Категория Revit не прочитана';
  return {key:JSON.stringify(['rvt',name]),name,format:'RVT'};
}
