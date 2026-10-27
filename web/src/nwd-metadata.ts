import type {BimElement} from './model';

export interface NativeNwdData {elements:BimElement[];byIndex:Map<number,BimElement>;rootId:string|null}
export function nativeNwdData(logical:any,namespace:string,key:string,hash:string):NativeNwdData {
 const nodes:any[]=Array.isArray(logical?.nodes)?logical.nodes:[];
 const inline=new Map<number,any>((logical?.objects??[]).map((o:any)=>[o.serialized_id,o]));
 const pages=new Map<string,any>((logical?.property_objects??[]).map((o:any)=>[JSON.stringify([o.page_index,o.serialized_id]),o]));
 const byIndex=new Map<number,BimElement>(),elements:BimElement[]=[];
 for(const node of nodes){
  if(!Number.isSafeInteger(node.index)||node.index<0||byIndex.has(node.index))throw Error('NWD: неверный индекс исходного дерева');
  const id=`nwd-node:${key}:${node.index}`,groups:Record<string,Record<string,unknown>>=Object.create(null),sources:Record<string,unknown>[]=[],base:Record<string,unknown>={'Node index':node.index,'Serialized ID':node.serialized_id,'Namespace':namespace,'Native GUID':node.native_guid??null,'GUID status':node.guid_status,'Logical stream':logical.stream,'Record offset':node.record_offset,'Record bytes':node.record_bytes,'Unresolved attribute slots':node.unresolved_attribute_slots};
  let revitId:string|undefined,ifcGuid='';
  const put=(group:string,name:string,value:unknown,source:Record<string,unknown>)=>{
   const target=groups[group]??=Object.create(null);
   if(Object.hasOwn(target,name)&&JSON.stringify(target[name])!==JSON.stringify(value))target[name]={state:'conflict',values:[target[name],value]};else target[name]=value;
   sources.push({...source,group,field:name,value});
  };
  for(const ref of node.attributes??[]){
   const page=ref.page_index??null,table=page===null?inline:pages;
   const get=(id:number)=>page===null?(table as Map<number,any>).get(id):(table as Map<string,any>).get(JSON.stringify([page,id]));
   const attribute=get(ref.serialized_id);if(!attribute)continue;
   const label=get(attribute.type_reference)?.values??{},group=String(label.display||label.internal||`NWD class ${attribute.serialized_class}`);
   const evidence={source_node_id:id,stream:ref.stream,page_index:page,serialized_id:attribute.serialized_id,record_offset:attribute.record_offset,record_bytes:attribute.record_bytes,category_internal:label.internal??null};
   if(attribute.serialized_class===86){
    for(const p of attribute.values?.properties??[]){const name=get(p.name_reference)?.values??{},cell=p.value??{};
     let value=cell.value;if(cell.tag===8&&value&&typeof value==='object')value=value.display??value.internal??value;
     const field=String(name.display||name.internal||`Property ${p.name_reference}`);
     put(group,field,value,{...evidence,parameter_internal:name.internal??null,parameter_name_reference:p.name_reference,value_tag:cell.tag});
     if(name.internal==='lcatfconsumer_parameter_IfcGUID'&&typeof value==='string'&&/^[0-9A-Za-z_$]{22}$/.test(value))ifcGuid=value;
    }
   }else if(attribute.serialized_class===66){
    const value=attribute.values?.uint64_decimal;
    put(group,String(label.display||label.internal||'Value'),label.internal==='LcOpDwgEntityAttrib'?attribute.values?.uint64_hex:value,{...evidence,value_tag:'uint64_decimal'});
    if(label.internal==='LcRevitId'&&typeof value==='string'&&/^\d+$/.test(value))revitId=value;
   }else if(attribute.serialized_class===70){put(group,String(label.display||label.internal||'Value'),attribute.values?.string_value,{...evidence,value_tag:'string'});
   }else if(attribute.serialized_class===31){put(group,'Name',attribute.name,{...evidence,value_tag:'material_name'});
   }else if(attribute.serialized_class===79){put(group,'Hyperlinks',attribute.values?.hyperlinks,{...evidence,value_tag:'hyperlinks'});}
  }
  groups['NWD source']=base;
  const element:BimElement={id,step_id:node.serialized_id,global_id:ifcGuid,class:node.class_name||'NwdSourceNode',hierarchy:['NwdSourceNode',node.class_name||'NwdSourceNode'],name:node.name||node.class_display||`Узел NWD #${node.index}`,role:'other',semantic_kind:'source_node',storey_id:null,predefined_type:null,materials:[],property_sets:groups,quantity_sets:{},source:{kind:'explicit',file_sha256:hash,step_id:node.serialized_id},mesh:null,geometry_error:null,
   nwd:{kind:'node',namespace,node_index:node.index,parent_id:node.parent_index===null?null:`nwd-node:${key}:${node.parent_index}`,native_guid:node.native_guid,property_sources:sources},
   ...(revitId?{revit:{element_id:revitId,id_basis:'explicit NWD LcRevitId property',phase_status:'not_read'}}:{})};
  elements.push(element);byIndex.set(node.index,element);
 }
 // Resolve inheritance by source hierarchy. Keep own and inherited provenance
 // separate; a fragment inheriting an ElementId is not a new physical instance.
 const byId=new Map(elements.map(e=>[e.id,e]));
 const resolve=(element:BimElement,active:Set<string>)=>{
  if(active.has(element.id))throw Error('NWD: цикл исходного дерева');if(active.size>256)throw Error('NWD: превышена глубина дерева');
  const parentId=element.nwd?.parent_id;if(!parentId)return;
  const parent=byId.get(parentId);if(!parent)throw Error('NWD: родитель исходного дерева не найден');
  active.add(element.id);if(!resolved.has(parent.id)){resolve(parent,active);resolved.add(parent.id);}active.delete(element.id);
  const inherited:Record<string,Record<string,unknown>>=Object.create(null);
  for(const [name,values]of Object.entries(parent.property_sets))if(name!=='NWD source')inherited[name]=values;
  for(const [name,values]of Object.entries(element.property_sets))inherited[name]=inherited[name]?{...inherited[name],...values}:values;
  element.property_sets=inherited;
  if(!element.revit&&parent.revit)element.revit={...parent.revit,id_basis:'NWD LcRevitId inherited from source parent '+parent.id};
  if(!element.global_id&&parent.global_id)element.global_id=parent.global_id;
  if(element.nwd){element.nwd.category_name=parent.class==='LcRevitLayer'?parent.name:parent.nwd?.category_name;element.nwd.property_sources=[...(parent.nwd?.property_sources??[]),...(element.nwd.property_sources??[])];}
 };
 const resolved=new Set<string>();for(const element of elements){if(!resolved.has(element.id))resolve(element,new Set());resolved.add(element.id);}
 return {elements,byIndex,rootId:elements.find(e=>e.nwd?.parent_id===null)?.id??null};
}
