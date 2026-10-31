import type {ModelPackage} from './model';
import {validatePackage} from './model.ts';

export interface SceneIfcOptions {
 ids?:string[];properties?:boolean;detailedSources?:boolean;maxBytes?:number;
 progress?:(message:string)=>void;
}
export interface SceneIfcReport {
 scope:'all'|'subset';records:number;products:number;groups:number;storeys:number;
 triangles:number;lineSegments:number;properties:boolean;detailedSources:boolean;
 sourceCompletenessVerified:false;sourceModelId:string;bytes:number;
}
const alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const guidPattern=/^[0-3][0-9A-Za-z_$]{21}$/;
/** Export the current SI model package, not the renderer's camera, clipping,
 * simulation actors or decorative helpers. No source quantities are inferred. */
export async function exportSceneIfc(model:ModelPackage,binary:ArrayBuffer,web:any,api:any,options:SceneIfcOptions={}){
 validatePackage(model,binary);
 const limit=options.maxBytes??512*1024**2;
 if(!Number.isSafeInteger(limit)||limit<1)throw Error('Некорректный бюджет экспорта IFC.');
 const selected=options.ids===undefined?null:new Set(options.ids),allIds=new Set<string>();
 for(const e of model.elements){if(allIds.has(e.id))throw Error('Повторный ID элемента в сцене.');allIds.add(e.id);}
 if(selected&&[...selected].some(id=>!allIds.has(id)))throw Error('Выборка IFC ссылается на неизвестные элементы.');
 const elements=model.elements.filter(e=>!selected||selected.has(e.id));
 if(!elements.some(e=>e.mesh&&e.mesh.vertex_count>0&&e.mesh.index_count>0))throw Error('В выбранной части сцены нет геометрии для IFC.');
 if(model.coordinate_system.up_axis!=='Z'||!model.coordinate_system.render_origin_m.every(Number.isFinite))throw Error('Координаты сцены для IFC не определены.');
 const S=web.IFC4,L=(v:string|null)=>v===null?null:new S.IfcLabel(v),N=(v:number)=>new S.IfcLengthMeasure(v),R=(v:number)=>new S.IfcReal(v);
 const notify=(s:string)=>{try{options.progress?.(s);}catch{}};
 const report:SceneIfcReport={scope:selected?'subset':'all',records:elements.length,products:0,groups:0,storeys:model.storeys.length,triangles:0,lineSegments:0,properties:options.properties!==false,detailedSources:options.detailedSources===true,sourceCompletenessVerified:false,sourceModelId:model.model_id,bytes:0};
 let estimated=0;const reserve=(n:number)=>{estimated+=n;if(estimated>limit)throw Error('IFC превышает бюджет обработки. Выберите часть сцены или отключите подробные свойства.');};
 const counts=new Map<string,number>();for(const e of elements)if(guidPattern.test(e.global_id))counts.set(e.global_id,(counts.get(e.global_id)??0)+1);
 const used=new Set<string>();
 async function guid(kind:string,key:string,original?:string){
  if(original&&counts.get(original)===1&&!used.has(original)){used.add(original);return new S.IfcGloballyUniqueId(original);}
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['uvyazka-scene-ifc-1',model.model_id,kind,key]))));
  let number=0n;for(const b of bytes.slice(0,16))number=(number<<8n)|BigInt(b);
  let value='';for(let i=0;i<22;i++){value=alphabet[Number(number&63n)]+value;number>>=6n;}
  if(used.has(value))throw Error('Конфликт идентификаторов экспорта IFC.');used.add(value);return new S.IfcGloballyUniqueId(value);
 }
 const handle=(line:any)=>new web.Handle(line.expressID);
 const m=api.CreateModel({schema:'IFC4',name:model.source.filename,description:['Uvyazka derived coordination scene; source completeness and quantities not approved'],authors:['Uvyazka'],organizations:[''],authorization:'Unapproved derived scene'});
 if(!Number.isInteger(m)||m<0)throw Error('Не удалось создать IFC.');
 const E=(name:string,...args:any[])=>{const row=new S[name](...args);api.WriteLine(m,row);return handle(row);};
 const point=(v:number[])=>E('IfcCartesianPoint',v.map(N));
 const jsonCache=new WeakMap<object,string>();
 const text=(value:any):string=>{if(value&&typeof value==='object'){let t=jsonCache.get(value);if(t===undefined){t=JSON.stringify(value);jsonCache.set(value,t);}return t;}return String(value);};
 const cells=new Map<string,any>();
 const cell=(name:string,value:any)=>{
  const object=value!==null&&typeof value==='object',encoded=value===undefined?'undefined':value===null?'null':text(value),key=JSON.stringify([name,typeof value,encoded]);
  if(cells.has(key))return cells.get(key);
  reserve(120+name.length*6+encoded.length*6);
  let typed=null;
  if(typeof value==='boolean')typed=new S.IfcBoolean(value);
  else if(typeof value==='number'&&Number.isFinite(value))typed=Number.isInteger(value)&&!Number.isSafeInteger(value)?new S.IfcText(String(value)):R(value);
  else if(value!==null&&value!==undefined)typed=new S.IfcText(encoded);
  // The web-ifc tape has a bounded encoded string field. Long values are
  // losslessly represented as ordered text chunks rather than silently lost.
  const result=encoded.length>2048&&typed instanceof S.IfcText
   ?E('IfcPropertyListValue',new S.IfcIdentifier(name),new S.IfcText('Uvyazka text chunks; concatenate ListValues in order'+(object?'; JSON representation of the read source value':'')),(encoded.match(/[\s\S]{1,2048}/gu)??[]).map(t=>new S.IfcText(t)),null)
   :E('IfcPropertySingleValue',new S.IfcIdentifier(name),object?new S.IfcText('JSON representation of the read source value'):null,typed,null);
  cells.set(key,result);return result;
 };
 let psetOrdinal=0;
 async function pset(product:any,name:string,values:Record<string,unknown>){
  const entries=Object.entries(values);if(!entries.length)return;
  const properties=entries.map(([key,value])=>cell(key,value)),key=String(psetOrdinal++);
  reserve(250+properties.length*12);
  const set=E('IfcPropertySet',await guid('pset',key),null,L(name),null,properties);
  E('IfcRelDefinesByProperties',await guid('defines',key),null,null,null,[product],set);
 }
 try{
  notify('Подготовка структуры IFC…');
  const zero=E('IfcAxis2Placement3D',point([0,0,0]),null,null),context=E('IfcGeometricRepresentationContext',null,L('Model'),new S.IfcDimensionCount(3),R(1e-6),zero,null);
  const unit=E('IfcSIUnit',S.IfcUnitEnum.LENGTHUNIT,null,S.IfcSIUnitName.METRE),units=E('IfcUnitAssignment',[unit]);
  const project=E('IfcProject',await guid('project','scene'),null,L(model.source.filename),new S.IfcText('Derived scene of read model data'),null,null,null,[context],units);
  // Positions are already in metres and relative to render_origin_m. Neither
  // source length_to_m nor member transforms may be applied a second time.
  const placement=E('IfcLocalPlacement',null,E('IfcAxis2Placement3D',point(model.coordinate_system.render_origin_m),null,null));
  const building=E('IfcBuilding',await guid('building','scene'),null,L('Сводная сцена'),null,null,placement,null,null,S.IfcElementCompositionEnum.ELEMENT,null,null,null);
  E('IfcRelAggregates',await guid('aggregate','building'),null,null,null,project,[building]);
  await pset(project,'Uvyazka_Scene',{SourceModelId:model.model_id,SourceFileSha256:model.source.sha256,Importer:model.importer_version,Scope:report.scope,PropertiesIncluded:report.properties,DetailedSourcesIncluded:report.detailedSources,SourceCompletenessVerified:false,QuantitiesApproved:false,CoordinateUnit:'m',SourceLengthToMetres:model.coordinate_system.length_to_m,SourceCalibration:model.source.calibrations??model.source.calibration??null,SourceCapabilities:model.capabilities,SourceDiagnostics:model.diagnostics,Federation:model.federation??null});
  if(report.properties)await pset(project,'Uvyazka_ReadRelations',{SourceRelationships:model.relationships,EngineeringLinks:model.engineering_links??null});
  const levels=new Map<string,any>(),containers=new Map<any,any[]>();
  for(const s of model.storeys){
   let origin=s.placement_origin_m;
   if(origin&&(!Array.isArray(origin)||origin.length!==3||!origin.every(Number.isFinite)))throw Error('Некорректное размещение уровня IFC.');
   // Federation has already placed both storeys and meshes in world metres.
   const levelPlacement=origin?E('IfcLocalPlacement',null,E('IfcAxis2Placement3D',point(origin),null,null)):placement;
   const level=E('IfcBuildingStorey',await guid('storey',s.id),null,L(s.name),null,null,levelPlacement,null,null,S.IfcElementCompositionEnum.ELEMENT,origin?N(origin[2]-model.coordinate_system.render_origin_m[2]):null);levels.set(s.id,level);
   await pset(level,'Uvyazka_Level',{SourceStoreyId:s.id,SourceElevationMetres:s.elevation_m,SourcePlacementOriginMetres:s.placement_origin_m,WorldPlacementRead:origin!=null});
  }
  if(levels.size)E('IfcRelAggregates',await guid('aggregate','storeys'),null,null,null,building,[...levels.values()]);
  const styles=new Map<string,any>();
  function style(item:any,source:any,line=false){
   if(!source)return;const key=JSON.stringify([line,source]);let cached=styles.get(key);
   if(!cached){
    if(!Array.isArray(source.color)||source.color.length!==3||!source.color.every((x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1)||!Number.isFinite(source.opacity)||source.opacity<0||source.opacity>1)throw Error('Некорректный материал сцены.');
    const rgb=E('IfcColourRgb',L(source.name??null),...source.color.map((n:number)=>new S.IfcNormalisedRatioMeasure(n)));
    if(line)cached=E('IfcCurveStyle',L(source.name??null),null,null,rgb,null);
    else {const rendering=E('IfcSurfaceStyleRendering',rgb,new S.IfcNormalisedRatioMeasure(1-source.opacity),null,null,null,null,null,null,S.IfcReflectanceMethodEnum.NOTDEFINED);
     cached=E('IfcSurfaceStyle',L(source.name??null),S.IfcSurfaceSide.BOTH,[rendering]);}
    styles.set(key,cached);
   }
   E('IfcStyledItem',item,[cached],null);
  }
  const products=new Map<string,any>(),groups=new Map<string,any>();
  for(let ordinal=0;ordinal<elements.length;ordinal++){
   const e=elements[ordinal];if(ordinal%64===0)notify(`Геометрия и свойства: ${ordinal} из ${elements.length}`);
   reserve(1600+e.name.length*6);let product:any;const mesh=e.mesh;
   if(mesh&&mesh.vertex_count&&mesh.index_count){
    const vertices=new Float32Array(binary,mesh.position_byte_offset,mesh.vertex_count*3),indices=new Uint32Array(binary,mesh.index_byte_offset,mesh.index_count),lines=mesh.primitive==='lines';
    if(indices.length%(lines?2:3)||vertices.some(v=>!Number.isFinite(v))||indices.some(i=>i>=mesh.vertex_count))throw Error('Геометрия элемента повреждена; IFC не сформирован.');
    reserve(mesh.vertex_count*100+mesh.index_count*12);
    const coords=lines?null:E('IfcCartesianPointList3D',Array.from({length:mesh.vertex_count},(_,i)=>[N(vertices[i*3]),N(vertices[i*3+1]),N(vertices[i*3+2])]));
    const items:any[]=[];
    if(lines){
     // The current web-ifc writer drops LIST-valued select wrappers such as
     // IfcLineIndex. Standard polylines preserve disconnected segment pairs.
     const linePoints=new Map<number,any>();
     const endpoint=(i:number)=>{let p=linePoints.get(i);if(!p){p=point([vertices[i*3],vertices[i*3+1],vertices[i*3+2]]);linePoints.set(i,p);}return p;};
     for(let i=0;i<indices.length;i+=2){const curve=E('IfcPolyline',[endpoint(indices[i]),endpoint(indices[i+1])]);items.push(curve);style(curve,mesh.styles[0],true);report.lineSegments++;}
    }else{
     const ranges=mesh.groups.length?mesh.groups:[{start:0,count:indices.length,material_index:0}];let covered=0;
     for(const range of ranges){
      if(!Number.isInteger(range.start)||!Number.isInteger(range.count)||range.start!==covered||range.count<0||range.count%3||range.start+range.count>indices.length)throw Error('Группы граней IFC не покрывают исходную геометрию.');
      covered+=range.count;if(!range.count)continue;
      const triangles=Array.from({length:range.count/3},(_,i)=>Array.from(indices.subarray(range.start+i*3,range.start+i*3+3),n=>new S.IfcPositiveInteger(n+1)));
      const item=E('IfcTriangulatedFaceSet',coords,null,null,triangles,null);items.push(item);style(item,mesh.styles[range.material_index]);report.triangles+=triangles.length;
     }
     if(covered!==indices.length)throw Error('Не все грани включены в IFC.');
    }
    const shape=E('IfcShapeRepresentation',context,L(lines?'Axis':'Body'),L(lines?'Curve3D':'Tessellation'),items),representation=E('IfcProductDefinitionShape',null,null,[shape]);
    product=E('IfcBuildingElementProxy',await guid('element',e.id,e.global_id),null,L(e.name),new S.IfcText('Derived read geometry; not a verified physical quantity'),L(e.class),placement,representation,new S.IfcIdentifier(e.revit?.element_id??e.tag??e.source_element_id??e.id),S.IfcBuildingElementProxyTypeEnum.NOTDEFINED);products.set(e.id,product);report.products++;
    const container=levels.get(e.storey_id??'')??building;const rows=containers.get(container)??[];rows.push(product);containers.set(container,rows);
   }else{product=E('IfcGroup',await guid('group',e.id,e.global_id),null,L(e.name),new S.IfcText('Read source record without scene geometry'),L(e.class));groups.set(e.id,product);report.groups++;}
   await pset(product,'Uvyazka_Source',{SceneElementId:e.id,SourceClass:e.class,SourceRole:e.role,SourceSemanticKind:e.semantic_kind??null,SourceIfcGlobalId:e.global_id||null,RevitElementId:e.revit?.element_id??null,RevitUniqueId:e.revit?.unique_id??null,SourceFileSha256:e.source.file_sha256,SourceModelId:e.source_model_id??model.model_id,SourceInstanceId:e.source_instance_id??null,SourceElementId:e.source_element_id??e.id,SourceStepId:e.source_step_id??e.step_id,SourceStoreyId:e.storey_id,SourceRecord:e.source,SourceLongName:e.long_name??null,SourceTag:e.tag??null,NavisOwnerId:e.nwd?.owner_id??null,NavisParentId:e.nwd?.parent_id??null,GeometryEvidence:e.geometry_evidence??null,GeometryError:e.geometry_error,Materials:e.materials,StyleData:mesh?.styles??null,QuantitiesApproved:false});
   if(e.revit)await pset(product,'Revit Identity',{ElementId:e.revit.element_id,UniqueId:e.revit.unique_id??null});
   if(report.properties){for(const [name,values]of Object.entries(e.property_sets))await pset(product,name.startsWith('Uvyazka_')||name==='Revit Identity'?'Source: '+name:name,values);
    if(Object.keys(e.quantity_sets).length||e.source_quantities)await pset(product,'Uvyazka_ReadQuantities',{QuantitiesJSON:e.quantity_sets,SourceQuantitiesJSON:e.source_quantities??null});
   }
   if(report.detailedSources)await pset(product,'Uvyazka_DetailedSources',{Revit:e.revit??null,Navis:e.nwd??null,LongName:e.long_name??null,Tag:e.tag??null,Materials:e.materials});
  }
  let relation=0;
  for(const [container,rows]of containers)E('IfcRelContainedInSpatialStructure',await guid('contain',String(relation++)),null,null,null,rows,container);
  const membership=new Map<any,any[]>();
  for(const e of elements){const parent=groups.get(e.nwd?.owner_id??e.nwd?.parent_id??'');const child=products.get(e.id)??groups.get(e.id);if(parent&&child&&parent.value!==child.value){const rows=membership.get(parent)??[];rows.push(child);membership.set(parent,rows);}}
  for(const [parent,children]of membership)E('IfcRelAssignsToGroup',await guid('group-members',String(relation++)),null,null,null,children,null,parent);
  const sourceGroups=new Map<string,any>();
  const members=model.federation?.members??[{instance_id:'source',model_id:model.model_id,label:model.source.filename,offset_m:[0,0,0],rotation_deg:0}];
  for(const member of members){const group=E('IfcGroup',await guid('source-model',member.instance_id),null,L(member.label),null,L('Uvyazka scene source'));sourceGroups.set(member.instance_id,group);await pset(group,'Uvyazka_SourceModel',{SourceMember:member});}
  for(const [instance,group]of sourceGroups){const related=elements.filter(e=>(e.source_instance_id??'source')===instance).map(e=>products.get(e.id)??groups.get(e.id));if(related.length)E('IfcRelAssignsToGroup',await guid('source-members',instance),null,null,null,related,null,group);}
  for(const system of model.systems??[]){
   const entity=E('IfcSystem',await guid('system',system.id),null,L(system.name),system.description?new S.IfcText(system.description):null,L(system.class));
   const related=[...new Set(system.member_ids)].map(id=>products.get(id)??groups.get(id)).filter(Boolean);
   if(related.length)E('IfcRelAssignsToGroup',await guid('system-members',system.id),null,null,null,related,null,entity);
   await pset(entity,'Uvyazka_System',{SourceSystemId:system.id,SourceGlobalId:system.global_id??null,SourceMemberIds:system.member_ids,ExportedMembers:related.length,ConnectivityVerified:system.connectivity_verified});
   if(report.properties)for(const [name,values]of Object.entries(system.property_sets??{}))await pset(entity,name.startsWith('Uvyazka_')?'Source: '+name:name,values);
  }
  notify('Подготовка файла IFC…');const chunks:Uint8Array[]=[];
  const encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true}),unicode=stepUnicodeWriter(part=>{
   const chunk=encode.encode(part);report.bytes+=chunk.byteLength;
   if(report.bytes>limit)throw Error('IFC превышает бюджет обработки. Выберите часть сцены или отключите подробные свойства.');chunks.push(chunk);
  });
  api.SaveModelToCallback(m,(chunk:Uint8Array)=>unicode(decode.decode(chunk,{stream:true})));
  unicode(decode.decode(),true);
  if(!report.bytes)throw Error('IFC не сформирован.');return {chunks,report};
 }finally{api.CloseModel(m);}
}

/** web-ifc emits UTF-16 surrogate pairs in X2 blocks; STEP requires X4 for
 * supplementary code points. Preserve escaped literal backslashes and accept
 * arbitrary callback chunk boundaries without rewriting user string content. */
export function stepUnicodeWriter(emit:(text:string)=>void){
 let pending='';
 return (part:string,flush=false)=>{
  const text=pending+part;pending='';let i=0,last=0;
  while(i<text.length){
   if(text[i]!=='\\'){i++;continue;}
   if(text[i+1]==='\\'){i+=2;continue;}
   if(!flush&&text.length-i<4)break;
   if(text.slice(i,i+4)!=='\\X2\\'){i++;continue;}
   const end=text.indexOf('\\X0\\',i+4);if(end<0){if(flush)throw Error('Не удалось записать текст IFC.');break;}
   const hex=text.slice(i+4,end);if(hex.length%4||!/^[0-9A-Fa-f]*$/.test(hex))throw Error('Некорректная кодировка текста IFC.');
   const units=hex.match(/.{4}/g)??[],codes:number[]=[];let supplementary=false;
   for(let k=0;k<units.length;k++){
    const u=parseInt(units[k],16);
    if(u>=0xd800&&u<=0xdbff){const v=parseInt(units[++k]??'',16);if(!(v>=0xdc00&&v<=0xdfff))throw Error('Некорректный символ в тексте IFC.');codes.push(0x10000+(u-0xd800)*1024+v-0xdc00);supplementary=true;}
    else{if(u>=0xdc00&&u<=0xdfff)throw Error('Некорректный символ в тексте IFC.');codes.push(u);}
   }
   if(supplementary){emit(text.slice(last,i));emit('\\X4\\'+codes.map(n=>n.toString(16).toUpperCase().padStart(8,'0')).join('')+'\\X0\\');last=end+4;}
   i=end+4;
  }
  emit(text.slice(last,i));pending=text.slice(i);
  if(flush&&pending){emit(pending);pending='';}
 };
}
