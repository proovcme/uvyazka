import type {ModelPackage,BimElement,Vec3} from './model';
import {nativeNwdData} from './nwd-metadata.ts';
export const nwdUnits={m:1,mm:.001,cm:.01,ft:.3048,in:.0254,yd:.9144,km:1000,mi:1609.344,um:.000001,mil:.0000254,uin:.0000000254} as const;
export type NwdUnit=keyof typeof nwdUnits;
const sourceModels=(result:any):any[]=>result.models??[{namespace:'',geometry:result.geometry,fragments:result.fragments,logical_model:result.logical_models?.[0],geometry_complete:!result.fragments?.diagnostic,diagnostics:[]}];
function calibration(source:any,unit?:NwdUnit){
 const observed=source.logical_model?.partition?.tail?.units;
 if(observed?.status==='decoded'&&typeof observed.scale_to_m==='number'&&Number.isFinite(observed.scale_to_m)&&observed.scale_to_m>0)return {namespace:String(source.namespace),unit:String(observed.unit),length_to_m:observed.scale_to_m,basis:'source' as const,source_units_decoded:true};
 if(!unit||!Object.hasOwn(nwdUnits,unit))throw Error('NWD_UNITS_REQUIRED: исходные единицы не прочитаны');
 return {namespace:String(source.namespace),unit,length_to_m:nwdUnits[unit],basis:'user_assumption' as const,source_units_decoded:false};
}
export function nwdNeedsUnits(result:any):boolean{return sourceModels(result).some(s=>{try{calibration(s);return false;}catch{return true;}});}
/** Source nodes retain their identity. Geometric fragments remain separate,
 * explicitly ineligible for counting physical equipment. */
export async function importNwd(result:any,filename:string,unit?:NwdUnit,options:{geometryBudgetBytes?:number}={}):Promise<{model:ModelPackage;binary:ArrayBuffer}>{
 const budget=options.geometryBudgetBytes??256*1024**2;
 if(!Number.isSafeInteger(budget)||budget<0||budget>256*1024**2)throw Error('NWD: недопустимый бюджет сцены');
 const models=sourceModels(result),calibrations=models.map(s=>calibration(s,unit)),hash=result.container.source_sha256;
 if(!models.length)throw Error('NWD: модельные потоки не найдены');
 const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['nwd-v2',hash,calibrations])))),n=>n.toString(16).padStart(2,'0')).join('');
 const low:Vec3=[Infinity,Infinity,Infinity],high:Vec3=[-Infinity,-Infinity,-Infinity],elements:BimElement[]=[],relationships:ModelPackage['relationships']=[],diagnostics:ModelPackage['diagnostics']=[];
 let size=0,triangles=0,fragmentCount=0,geometryErrors=0,logicalCount=0;
 const projected:any[]=[],sources:NonNullable<ModelPackage['nwd']>['source_models']=[];
 for(let sourceIndex=0;sourceIndex<models.length;sourceIndex++){
  const source=models[sourceIndex],scale=calibrations[sourceIndex].length_to_m,key=String(sourceIndex),namespace=String(source.namespace??''),native=nativeNwdData(source.logical_model,namespace,key,hash);
  logicalCount+=native.elements.length;for(const e of native.elements)elements.push(e);
  sources.push({namespace,root_id:native.rootId,geometry_complete:!!source.geometry_complete,metadata_status:source.logical_model?.status??'not_read'});
  for(const node of native.elements)if(node.nwd?.parent_id)relationships.push({step_id:node.step_id,class:'NwdLogicalHierarchy',parent_id:node.nwd.parent_id,child_ids:[node.id]});
  for(const f of source.fragments?.rows??[]){
   const g=source.geometry?.[f.geometry_index];if(!g)throw Error('NWD: ссылка за пределами каталога геометрии');
   const owner=native.byIndex.get(f.owner_reference),primitive=g.serialized_class===94?'triangles':'lines',topology=(primitive==='triangles'?g.triangles:g.lines) as number[][],matrix=f.placement_matrix_source_units;
   let indexCount=0;for(const row of topology){indexCount+=row.length;for(const v of row)if(!Number.isSafeInteger(v)||v<0||v>=g.positions.length)throw Error('NWD: индекс вне массива координат');}
   let valid=!g.diagnostic&&f.primitive_count_matches&&f.local_bounds_match&&indexCount>0;
   // Check the scene budget before allocating per-instance transformed arrays.
   // Unrendered fragments still keep ownership and source properties.
   const bytes=g.positions.length*12+indexCount*4;
   if(valid&&size+bytes>budget){valid=false;if(!diagnostics.some(d=>d.kind==='nwd-memory-budget'))diagnostics.push({element_id:'',kind:'nwd-memory-budget',message:`Часть геометрии не подготовлена: бюджет сцены ${budget} байт. Исходное дерево и свойства сохранены.`});}
   const indices=valid?topology.flat():[];
   if(matrix&&(!Array.isArray(matrix)||matrix.length!==16||matrix.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v))))throw Error('NWD: неверная матрица размещения');
   const positions=(valid?g.positions.map((p:number[])=>p.map((v,k)=>matrix?(matrix[k]*p[0]+matrix[4+k]*p[1]+matrix[8+k]*p[2]+matrix[12+k])*scale:(v+f.translation[k])*scale)):[]) as Vec3[];
   if(positions.some(p=>p.length!==3||p.some(v=>!Number.isFinite(v)||Math.abs(v)>1e20)))throw Error('NWD: недопустимые преобразованные координаты');
   const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];for(const p of positions)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}
   const position_byte_offset=size;if(valid)size+=positions.length*12;const index_byte_offset=size;if(valid)size+=indices.length*4;
   if(valid)for(let k=0;k<3;k++){low[k]=Math.min(low[k],min[k]);high[k]=Math.max(high[k],max[k]);}
   else geometryErrors++;
   fragmentCount++;if(valid&&primitive==='triangles')triangles+=indices.length/3;
   projected.push({f,g,owner,primitive,indices,positions,min,max,valid,position_byte_offset,index_byte_offset,key,namespace});
  }
  for(const message of [...(source.diagnostics??[]),...(source.fragments?.diagnostic?[source.fragments.diagnostic]:[]),...(source.logical_model?.diagnostic?[source.logical_model.diagnostic]:[]),...(source.logical_model?.property_diagnostics??[])])diagnostics.push({element_id:'',kind:'nwd-partial',message:String(message)});
  diagnostics.push({element_id:'',kind:'nwd-coverage',message:`${namespace}: узлов дерева ${native.elements.length}; фрагментов ${source.fragments?.decoded??0}/${source.fragments?.declared??'не прочитано'}; страницы свойств ${source.logical_model?.decoded_property_slots??0}/${source.logical_model?.declared_property_slots??'не прочитано'}. Единицы ${calibrations[sourceIndex].unit}: ${calibrations[sourceIndex].source_units_decoded?'прочитаны из файла':'допущение пользователя'}.`});
 }
 if(!elements.length&&!projected.length)throw Error('NWD: поддержанные данные не прочитаны');
 if(!elements.length&&!projected.some(x=>x.valid))throw Error('NWD: нет геометрии, прошедшей проверки, и прочитанного исходного дерева');
 if(!low.every(Number.isFinite)){low.splice(0,3,0,0,0);high.splice(0,3,0,0,0);}
 const origin:Vec3=[(low[0]+high[0])/2,(low[1]+high[1])/2,low[2]],binary=new ArrayBuffer(size);
 for(const x of projected){const {f,g,owner}=x;
  if(x.valid){new Float32Array(binary,x.position_byte_offset,x.positions.length*3).set(x.positions.flatMap((p:Vec3)=>p.map((v:number,k:number)=>v-origin[k])));new Uint32Array(binary,x.index_byte_offset,x.indices.length).set(x.indices);}
  const fragmentId=`nwd-fragment:${x.key}:${f.serialized_id}`,nativeProps=owner?.property_sets??{};
  const element:BimElement={id:fragmentId,step_id:f.serialized_id,global_id:owner?.global_id??'',class:owner?.class??(x.primitive==='triangles'?'NwdTriangleFragment':'NwdLineFragment'),hierarchy:['NwdFragment',owner?.class??'NwdGeometryFragment'],name:owner?.name??`Фрагмент NWD #${f.serialized_id}`,role:'element',semantic_kind:'geometry_fragment',storey_id:null,predefined_type:null,materials:owner?.materials??[],
   property_sets:{...nativeProps,'NWD fragment':{'Serialized ID':f.serialized_id,'Owner node index':f.owner_reference,'Owner node ID':owner?.id??null,'Geometry reference':f.geometry_index+1,'Primitive count':f.primitive_count,'Namespace':x.namespace,'Fragment offset':f.record_offset,'Fragment bytes':f.record_bytes,'Geometry offset':g.record_offset,'Geometry bytes':g.record_bytes,'Placement matrix (source units)':f.placement_matrix_source_units??null,'Interpretation':'Геометрический фрагмент исходного узла; не отдельная единица оборудования'}},quantity_sets:{},
   source:{kind:'explicit',file_sha256:hash,step_id:f.serialized_id},geometry_error:x.valid?null:g.diagnostic||'NWD: геометрия не подготовлена или не прошла сверки',
   nwd:{kind:'fragment',namespace:x.namespace,node_index:f.owner_reference,owner_id:owner?.id,native_guid:owner?.nwd?.native_guid,category_name:owner?.nwd?.category_name,property_sources:owner?.nwd?.property_sources},...(owner?.revit?{revit:owner.revit}:{}),
   geometry_evidence:{engine:'uvyazka-nwd',body_source:'NWD fragment',status:f.status,quantity_eligible:false,requires_review:true,reason:'Проверенная геометрия фрагмента не доказывает количество физических объектов или полноту исходного проекта'},
   mesh:x.valid?{primitive:x.primitive as 'triangles'|'lines',bbox_min_m:x.min,bbox_max_m:x.max,position_byte_offset:x.position_byte_offset,index_byte_offset:x.index_byte_offset,vertex_count:x.positions.length,index_count:x.indices.length,representation_id:f.geometry_index+1,styles:[{name:'NWD material',color:f.material_raw.slice(0,3).map((v:number)=>Math.max(0,Math.min(1,v))) as Vec3,opacity:Math.max(0,Math.min(1,1-((f.appearance_flags&16)?0:(f.material_raw[12]??0))))}],groups:[{start:0,count:x.indices.length,material_index:0}],source:{kind:'derived',method:'NWD geometry + source placement matrix + explicit unit conversion',version:'2',representation_id:f.geometry_index+1}}:null};
  elements.push(element);if(owner)relationships.push({step_id:f.serialized_id,class:'NwdFragmentOwnership',parent_id:owner.id,child_ids:[fragmentId]});
 }
 const unread=result.unsupported_features??['saved viewpoints','clash results','TimeLiner','rendered textures'];
 diagnostics.push({element_id:'',kind:'nwd-limitations',message:'Не прочитаны или не отображаются: '+unread.join(', ')+'. Фрагменты не считаются оборудованием.'});
 const model:ModelPackage={contract:'ModelPackage',contract_version:'0.1.0',model_id:id,importer_version:'uvyazka-nwd-v2',source:{filename,sha256:hash,size_bytes:result.container.source_bytes,schema:`navisworks:${result.container.serialization_version??431}`,format:'nwd',exported_at:'',exporter:'uvyazka-independent-nwd',calibration:calibrations.length===1?calibrations[0]:undefined,calibrations},coordinate_system:{length_to_m:calibrations.length===1?calibrations[0].length_to_m:1,render_origin_m:origin,up_axis:'Z',bounds_min_m:low,bounds_max_m:high},elements,storeys:[],relationships,diagnostics,
  nwd:{logical_nodes:logicalCount,fragments:fragmentCount,source_models:sources,unread_features:unread},statistics:{products:elements.length,physical_elements:0,meshes:projected.filter(x=>x.valid).length,triangles,geometry_errors:geometryErrors,binary_bytes:size},capabilities:{read:true,geometry_ready:projected.some(x=>x.valid),technology_resolved:false,schedule_ready:false}};
 return {model,binary};
}
