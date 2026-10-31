import {RVT_READER_REVISION,RVT_DIRECT_IMPORTER} from './rvt-reader-version.ts';
import type {ModelPackage,BimElement,Vec3} from './model.ts';
import {validatePackage} from './model.ts';
import {identifier} from './rvt-document.ts';
import {parameter,parameterDefinitions} from './rvt-schedule.ts';
import type {ParameterRecord} from './rvt-schedule.ts';
export type RvtMode='ifc'|'direct';
export const rvtMode=(model:ModelPackage):RvtMode=>model.source.rvt_read_mode==='direct'?'direct':'ifc';
/** A source can be compared in both readers; those are not duplicate packages. */
export function sameReadSource(model:ModelPackage,sha:string,mode?:RvtMode){return model.source.sha256===sha&&(!mode||rvtMode(model)===mode);}
const hash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const vector=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&v.every(x=>typeof x==='number'&&Number.isFinite(x));
export async function importRvtDirect(result:any,source:{filename:string;sha256:string;size_bytes:number}):Promise<{model:ModelPackage;binary:ArrayBuffer}>{
 const data=result?.manifest,raw=result?.geometry_binary;
 if(data?.contract!=='RvtDirectScene'||data.version!==1||data.units!=='metres'||data.complete_document_geometry!==false||!Array.isArray(data.elements)||data.elements.length>2_000_000||!(raw instanceof Uint8Array)||!raw.byteLength||raw.byteLength>512*1024**2)throw Error('RVT напрямую: неподдерживаемый или повреждённый результат читателя.');
 for(const v of [data.render_origin_m,data.bounds_min_m,data.bounds_max_m])if(!vector(v))throw Error('RVT напрямую: координаты не прочитаны.');
 if(!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('RVT напрямую: отсутствует SHA-256 источника.');
 const binary=raw.byteOffset===0&&raw.byteLength===raw.buffer.byteLength?raw.buffer as ArrayBuffer:raw.slice().buffer as ArrayBuffer;
 const diagnostics:ModelPackage['diagnostics']=[{element_id:'',kind:'rvt_direct_experimental',message:'Экспериментальное прямое чтение сохранённой графики RVT. Полнота модели, физические количества, стадии и видимость Revit не подтверждены. IFC не создавался.'}];
 if(data.unrendered_records)diagnostics.push({element_id:'',kind:'rvt_direct_coverage',message:String(data.unrendered_records)+' записей не имеют пригодной сохранённой поверхности в этом наборе. Среди них есть служебные записи и типы; это не число пропущенных физических элементов.'});
 if(data.metadata_error)diagnostics.push({element_id:'',kind:'rvt_direct_metadata',message:String(data.metadata_error)});
 const ids=new Set<string>();let meshes=0,triangles=0,partial=0;
 const elements:BimElement[]=data.elements.map((row:any,index:number)=>{
  if(typeof row.element_id!=='string'||!/^\d+$/.test(row.element_id)||ids.has(row.element_id))throw Error('RVT напрямую: отсутствующий или повторный исходный ID.');ids.add(row.element_id);
  const id='rvt-element:'+row.element_id,metadata=row.metadata??{},fields=metadata.root_fields??{},nativeClass=typeof metadata.class_name==='string'?metadata.class_name:'RvtGraphicsOwner';
  const owner:ParameterRecord={identity:{element_id:row.element_id},class_name:nativeClass,status:String(metadata.status??'unknown'),source:metadata.source,saved_metadata:metadata.saved_metadata,root_fields:fields};
  const defs=data.parameter_definitions??{},sets:Record<string,Record<string,unknown>>={},parameterIds=new Set<string>();
  for(const set of owner.saved_metadata?.parameter_sets??[])for(const p of set.parameters??[])parameterIds.add(String(p.serialized_parameter_id));
  for(const list of ['raw_field_parameters','resolved_family_parameters','family_parameter_slots'])for(const p of owner.saved_metadata?.[list]??[])parameterIds.add(String(p.parameter_id));
  const localDefs=parameterDefinitions(owner);
  for(const pid of parameterIds){const cell=parameter(owner,pid);if(cell.state==='value'){const name=String((localDefs.find(d=>String(d.parameter_id)===pid)??defs[pid])?.caption||'Параметр '+pid);(sets['Параметры RVT · сохранённые значения']??={})[name+' ['+pid+']']=cell.value;}}
  sets['Источник RVT']={ElementId:row.element_id,UniqueId:row.unique_id??null,Класс:nativeClass,Статус:row.status,Адрес:row.source,Параметры:metadata.saved_metadata??null,Источник_параметров:metadata.source??null,Поля:fields,Материалы:row.material_evidence??null,Связанные_графы:row.referenced_graph_sources??null};
  const categoryId=identifier(fields.m_categoryId??metadata.saved_metadata?.root_references?.m_categoryId);
  if(categoryId)sets.Other={Category:'Категория RVT '+categoryId};
  const mesh=row.mesh??null;
  if(mesh){if(mesh.index_count%3||!vector(mesh.bbox_min_m)||!vector(mesh.bbox_max_m)||!Array.isArray(mesh.groups)||!Array.isArray(mesh.styles))throw Error('RVT напрямую: повреждённая сетка.');meshes++;triangles+=mesh.index_count/3;}
  if(!mesh||row.status!=='decoded_saved_graphics'||row.unbounded_faces>0)partial++;
  for(const message of (row.diagnostics??[]).slice(0,20))diagnostics.push({element_id:id,kind:'rvt_direct_graphics',message:String(message)});
  if(row.unresolved_material_primitives?.length)diagnostics.push({element_id:id,kind:'rvt_direct_material',message:'Часть материалов не прочитана; использован нейтральный цвет.'});
  return {id,step_id:index+1,global_id:'',class:nativeClass,hierarchy:[nativeClass],name:typeof fields.m_name==='string'&&fields.m_name.trim()?fields.m_name:nativeClass+' · Revit '+row.element_id,
   role:nativeClass==='RoomElem'?'space':'element',semantic_kind:'geometry_fragment',storey_id:null,predefined_type:null,materials:mesh?[...new Set<string>(mesh.styles.map((s:any)=>String(s.name)))]:[],property_sets:sets,quantity_sets:{},
   source:{kind:'explicit',file_sha256:source.sha256,step_id:index+1},mesh,geometry_error:mesh?null:'Сохранённая графика владельца не прочитана',
   geometry_evidence:{engine:'rvt_native_saved_graphics',body_source:'native_saved_graphics',status:String(row.status),quantity_eligible:false,requires_review:true,reason:'Владелец графики RVT не подтверждает отдельный физический экземпляр или расчётный объём.'},
   revit:{element_id:row.element_id,unique_id:typeof row.unique_id==='string'?row.unique_id:undefined,id_basis:'rvt_native_identity',phase_status:'not_read'}};
 });
 if(!meshes)throw Error('RVT напрямую: пригодная геометрия не получена. IFC автоматически не использовался.');
 const model:ModelPackage={contract:'ModelPackage',contract_version:'0.1.0',importer_version:RVT_DIRECT_IMPORTER,
  model_id:await hash(source.sha256+':rvt-direct:'+RVT_READER_REVISION),source:{...source,format:'rvt',schema:'Revit '+(data.revit_version??'версия не прочитана'),exporter:RVT_READER_REVISION+' native saved graphics',exported_at:'',rvt_read_mode:'direct'},
  coordinate_system:{length_to_m:0.3048,up_axis:'Z',render_origin_m:data.render_origin_m,bounds_min_m:data.bounds_min_m,bounds_max_m:data.bounds_max_m},storeys:[],elements,relationships:[],diagnostics,
  statistics:{products:elements.length,physical_elements:0,meshes,triangles,geometry_errors:elements.length-meshes,binary_bytes:binary.byteLength},
  capabilities:{read:true,geometry_ready:true,technology_resolved:false,schedule_ready:false},
  rvt_direct:{experimental:true,complete_document_geometry:false,graphics_owners:elements.length,observed_records:data.observed_records??elements.length,unrendered_records:data.unrendered_records??0,partial_owners:partial,metadata_error:data.metadata_error??null,parameter_definitions:data.parameter_definitions??{}}};
 validatePackage(model,binary);
 for(const e of elements)if(e.mesh){const m=e.mesh;const indices=new Uint32Array(binary,m.index_byte_offset,m.index_count);if(indices.some(i=>i>=m.vertex_count)||new Float32Array(binary,m.position_byte_offset,m.vertex_count*3).some(x=>!Number.isFinite(x)))throw Error('RVT напрямую: недопустимые координаты или индексы.');}
 return {model,binary};
}
