import type {BimElement} from './model';

export interface NativeNwdData {elements:BimElement[];byIndex:Map<number,BimElement>;rootId:string|null;diagnostics:string[];diagnostic_count:number}
export function nativeNwdData(logical:any,namespace:string,key:string,hash:string,progress?:(message:string)=>void):NativeNwdData {
 const nodes:any[]=Array.isArray(logical?.nodes)?logical.nodes:[];const notify=(message:string)=>{try{progress?.(message);}catch{/* A progress observer cannot invalidate source data. */}};
 const diagnostics:string[]=[];let omitted=0;const note=(message:string)=>{if(diagnostics.length<200)diagnostics.push(message);else omitted++;};
 const list=(v:any):any[]=>{if(Array.isArray(v))return v;if(v!==undefined&&v!==null)note('Некорректный список свойств не прочитан');return [];};
 const uniqueObjects=(rows:any[],page:boolean)=>{const map=new Map<any,any>(),duplicates=new Set<any>();for(const o of rows){if(!o||!Number.isSafeInteger(o.serialized_id)){note('Объект свойств без достоверного ID пропущен');continue;}const id=page?JSON.stringify([o.page_index,o.serialized_id]):o.serialized_id;if(map.has(id)){duplicates.add(id);note(`Повторный ID объекта свойств ${id}: ссылка не разрешена`);}else map.set(id,o);}for(const id of duplicates)map.delete(id);return map;};
 const inline=uniqueObjects(list(logical?.objects),false),pages=uniqueObjects(list(logical?.property_objects),true);
 const nodeCounts=new Map<number,number>();for(const n of nodes)if(Number.isSafeInteger(n?.index))nodeCounts.set(n.index,(nodeCounts.get(n.index)??0)+1);
 const byIndex=new Map<number,BimElement>(),elements:BimElement[]=[];
 const declaredRoots=new Set<number>();
 let visited=0;for(const node of nodes){
  if(visited++%4096===0)notify(`Подготовка узлов NWD: ${visited-1} из ${nodes.length}`);
  if(!Number.isSafeInteger(node?.index)||node.index<0||nodeCounts.get(node.index)!==1||!Number.isSafeInteger(node.serialized_id)){note(`Узел с недостоверным или повторным индексом ${node?.index??'не прочитан'} пропущен`);continue;}
  if(node.parent_index===null)declaredRoots.add(node.index);
  const id=`nwd-node:${key}:${node.index}`,groups:Record<string,Record<string,unknown>>=Object.create(null),sources:Record<string,unknown>[]=[],base:Record<string,unknown>={'Node index':node.index,'Serialized ID':node.serialized_id,'Namespace':namespace,'Native GUID':node.native_guid??null,'GUID status':node.guid_status,'Logical stream':logical.stream,'Record offset':node.record_offset,'Record bytes':node.record_bytes,'Unresolved attribute slots':node.unresolved_attribute_slots};
  let revitId:string|undefined,ifcGuid='';
  const put=(group:string,name:string,value:unknown,source:Record<string,unknown>)=>{
   const target=groups[group]??=Object.create(null);
   if(Object.hasOwn(target,name)&&JSON.stringify(target[name])!==JSON.stringify(value))target[name]={state:'conflict',values:[target[name],value]};else target[name]=value;
   sources.push({...source,group,field:name,value});
  };
  for(const ref of list(node.attributes)){
   if(!ref||!Number.isSafeInteger(ref.serialized_id)){note(`Узел ${node.index}: ссылка на свойство не прочитана`);continue;}
   const page=ref.page_index??null,table=page===null?inline:pages;
   const get=(id:number)=>page===null?(table as Map<number,any>).get(id):(table as Map<string,any>).get(JSON.stringify([page,id]));
   const attribute=get(ref.serialized_id);if(!attribute){note(`Узел ${node.index}: объект свойства ${ref.serialized_id} недоступен`);continue;}
   const label=get(attribute.type_reference)?.values??{},group=String(label.display||label.internal||`NWD class ${attribute.serialized_class}`);
   const evidence={source_node_id:id,stream:ref.stream,page_index:page,serialized_id:attribute.serialized_id,record_offset:attribute.record_offset,record_bytes:attribute.record_bytes,category_internal:label.internal??null};
   if(attribute.serialized_class===86){
    for(const p of list(attribute.values?.properties)){if(!p||typeof p!=='object'){note(`Узел ${node.index}: повреждённое свойство пропущено`);continue;}const name=get(p.name_reference)?.values??{},cell=p.value??{};
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
  if(failed.has(element.id))throw Error('NWD: исходная цепочка родителей не разрешена');
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
 const resolved=new Set<string>(),failed=new Set<string>();visited=0;for(const element of elements){if(visited++%4096===0)notify(`Сопоставление свойств NWD: ${visited-1} из ${elements.length}`);try{if(!resolved.has(element.id))resolve(element,new Set());resolved.add(element.id);}catch(error){failed.add(element.id);const original=element.nwd?.parent_id;if(element.nwd)element.nwd.parent_id=null;Object.assign(element.property_sets['NWD source'],{'Unresolved parent ID':original??null,'Hierarchy error':String(error)});note(`${element.id}: ${String(error)}; собственные свойства сохранены, наследование отключено`);}}
 const diagnostic_count=diagnostics.length+omitted;if(omitted)diagnostics.push(`Ещё ${omitted} сообщений о свойствах или дереве не развёрнуты.`);
 const roots=elements.filter(e=>declaredRoots.has(e.nwd!.node_index!));
 return {elements,byIndex,rootId:roots.length===1?roots[0].id:null,diagnostics,diagnostic_count};
}
