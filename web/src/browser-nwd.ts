import type {ModelPackage,BimElement,Vec3} from './model';
import {nativeNwdData} from './nwd-metadata.ts';
export const NWD_READER_REVISION='index-runs-v4-20261029';
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
export async function importNwd(result:any,filename:string,unit?:NwdUnit,options:{geometryBudgetBytes?:number;progress?:(message:string)=>void}={}):Promise<{model:ModelPackage;binary:ArrayBuffer}>{
 const notify=(message:string)=>{try{options.progress?.(message);}catch{/* Progress reporting is independent of decoding. */}};
 const budget=options.geometryBudgetBytes??256*1024**2;
 if(!Number.isSafeInteger(budget)||budget<0||budget>256*1024**2)throw Error('NWD: недопустимый бюджет сцены');
 const packedBytes=result.geometry_binary as Uint8Array|undefined;
 const unpacked=new Set<string>(),unpackErrors=new Map<string,string>();
 const unpack=(source:any,si:number,gi:number)=>{
  const key=si+':'+gi;if(unpacked.has(key))return;if(unpackErrors.has(key))throw Error(unpackErrors.get(key));
  const packed=result.packed_geometry?.[si]?.[gi];if(!packed){if(result.packed_geometry)throw Error('NWD: отсутствует описание бинарной геометрии');return;}
  if(!(packedBytes instanceof Uint8Array))throw Error('NWD: отсутствует бинарная геометрия');
  const view=(offset:number,count:number,kind:'position'|'index')=>{
   if(!Number.isSafeInteger(offset)||offset<0||offset%4||!Number.isSafeInteger(count)||count<0||count>12_000_000||offset+count*4>packedBytes.byteLength)throw Error('NWD: повреждён адрес бинарной геометрии');
   return kind==='position'?new Float32Array(packedBytes.buffer,packedBytes.byteOffset+offset,count):new Uint32Array(packedBytes.buffer,packedBytes.byteOffset+offset,count);
  };
  const group=(v:Float32Array|Uint32Array,n:number)=>Array.from({length:v.length/n},(_,i)=>Array.from(v.subarray(i*n,(i+1)*n)));
  if(packed.triangle_index_count%3||packed.line_index_count%2)throw Error('NWD: повреждён размер топологии');
  const positions=group(view(packed.position_byte_offset,packed.vertex_count*3,'position'),3),triangles=group(view(packed.triangle_byte_offset,packed.triangle_index_count,'index'),3),lines=group(view(packed.line_byte_offset,packed.line_index_count,'index'),2);
  Object.assign(source.geometry[gi],{positions,triangles,lines});unpacked.add(key);
 };
 const models=sourceModels(result),calibrations=models.map(s=>calibration(s,unit)),hash=result.container.source_sha256;
 if(!models.length)throw Error('NWD: модельные потоки не найдены');
 const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([NWD_READER_REVISION,hash,calibrations])))),n=>n.toString(16).padStart(2,'0')).join('');
 const low:Vec3=[Infinity,Infinity,Infinity],high:Vec3=[-Infinity,-Infinity,-Infinity],elements:BimElement[]=[],relationships:ModelPackage['relationships']=[],diagnostics:ModelPackage['diagnostics']=[];
 let size=0,triangles=0,fragmentCount=0,geometryErrors=0,logicalCount=0;
 const recoveryCounts=new Map<string,number>();let recoveryDetails=0;
 const note=(kind:string,message:string,element_id='',weight=1)=>{if(weight)recoveryCounts.set(kind,(recoveryCounts.get(kind)??0)+weight);if(recoveryDetails++<200)diagnostics.push({element_id,kind,message});};
 for(const block of result.container.blocks??[])if(block.diagnostic)note('nwd-block-unread',`${block.entry?.name??'Поток'}: ${block.diagnostic}`);
 const projected:any[]=[],sources:NonNullable<ModelPackage['nwd']>['source_models']=[];
 for(let sourceIndex=0;sourceIndex<models.length;sourceIndex++){
  const source=models[sourceIndex],scale=calibrations[sourceIndex].length_to_m,key=String(sourceIndex),namespace=String(source.namespace??'');
  let native:ReturnType<typeof nativeNwdData>;try{native=nativeNwdData(source.logical_model,namespace,key,hash,notify);}catch(error){native={elements:[],byIndex:new Map(),rootId:null,diagnostics:[String(error)],diagnostic_count:1};}
  if(native.diagnostic_count)recoveryCounts.set('nwd-metadata-recovery',(recoveryCounts.get('nwd-metadata-recovery')??0)+native.diagnostic_count);
  for(const message of native.diagnostics??[])note('nwd-metadata-recovery',`${namespace}: ${message}`,'',0);
  logicalCount+=native.elements.length;for(const e of native.elements)elements.push(e);
  sources.push({namespace,root_id:native.rootId,geometry_complete:!!source.geometry_complete,metadata_status:native.diagnostics?.length?'projected_with_questions':source.logical_model?.status??'not_read'});
  for(const node of native.elements)if(node.nwd?.parent_id)relationships.push({step_id:node.step_id,class:'NwdLogicalHierarchy',parent_id:node.nwd.parent_id,child_ids:[node.id]});
  const fragmentRows=Array.isArray(source.fragments?.rows)?source.fragments.rows:[],identityCounts=new Map<number,number>();
  for(const f of fragmentRows)if(Number.isSafeInteger(f?.serialized_id))identityCounts.set(f.serialized_id,(identityCounts.get(f.serialized_id)??0)+1);
  const checkedGeometry=new Map<number,{g:any;primitive:'triangles'|'lines';topology:number[][];indexCount:number}>();
  for(const f of fragmentRows){
   if(fragmentCount%1024===0)notify(`Подготовка геометрии NWD: источник ${sourceIndex+1} из ${models.length}, фрагментов обработано ${fragmentCount}`);
   fragmentCount++;
   if(!Number.isSafeInteger(f?.serialized_id)||f.serialized_id<2||identityCounts.get(f.serialized_id)!==1){geometryErrors++;sources[sourceIndex].geometry_complete=false;note('nwd-fragment-identity',`${namespace}: пропущен фрагмент с недостоверным или повторным ID ${f?.serialized_id??'не прочитан'}`);continue;}
   const fragmentId=`nwd-fragment:${key}:${f.serialized_id}`,owner=native.byIndex.get(f.owner_reference);
   let g:any={record_offset:null,record_bytes:null},primitive:'triangles'|'lines'='triangles',indices:number[]=[],positions:Vec3[]=[],valid=false,errorMessage:string|null=null;
   const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];
   try{
    if(Number.isSafeInteger(f.geometry_index)&&f.geometry_index>=0)g=source.geometry?.[f.geometry_index]??g;
    if(f.diagnostic)throw Error(String(f.diagnostic));
    if(!Number.isSafeInteger(f.geometry_index)||f.geometry_index<0||!source.geometry?.[f.geometry_index])throw Error('Ссылка за пределами каталога геометрии');
    const geometryKey=sourceIndex+':'+f.geometry_index;
    try{unpack(source,sourceIndex,f.geometry_index);}catch(error){unpackErrors.set(geometryKey,String(error));throw error;}
    g=source.geometry[f.geometry_index];if(g.diagnostic||g.record_diagnostic)throw Error(g.diagnostic??g.record_diagnostic);
    let checked=checkedGeometry.get(f.geometry_index);
    if(!checked){
     if(![94,95].includes(g.serialized_class))throw Error('Неподдержанный класс геометрии');
     primitive=g.serialized_class===94?'triangles':'lines';const topology=primitive==='triangles'?g.triangles:g.lines;
     if(!Array.isArray(g.positions)||g.positions.length>1_000_000||g.positions.some((p:any)=>!Array.isArray(p)||p.length!==3||p.some((v:any)=>typeof v!=='number'||!Number.isFinite(v))))throw Error('Недопустимый массив координат');
     if(!Array.isArray(topology)||topology.length>3_000_000)throw Error('Недопустимый массив топологии');
     let indexCount=0;for(const row of topology){if(!Array.isArray(row)||row.length!==(primitive==='triangles'?3:2))throw Error('Недопустимый размер примитива');indexCount+=row.length;for(const v of row)if(!Number.isSafeInteger(v)||v<0||v>=g.positions.length)throw Error('Индекс вне массива координат');}
     checked={g,primitive,topology,indexCount};checkedGeometry.set(f.geometry_index,checked);
    }
    primitive=checked.primitive;
    if(!checked.indexCount)throw Error('Прочитанная топология не содержит поддержанных примитивов');
    if(f.geometry_kind!==undefined&&f.geometry_kind!==(primitive==='triangles'?4:8))throw Error('Тип примитивов фрагмента не совпадает с определением геометрии');
    if(f.primitive_count_matches!==true||f.local_bounds_match!==true){sources[sourceIndex].geometry_complete=false;note('nwd-consistency-question',`${namespace}, фрагмент ${f.serialized_id}: сохранённые границы или количество примитивов расходятся с прочитанной геометрией; показаны проверенные координаты и топология`,fragmentId);}
    const bytes=g.positions.length*12+checked.indexCount*4;
    if(size+bytes>budget)throw Error(`Бюджет сцены ${budget} байт исчерпан; исходное дерево и свойства сохранены`);
    const matrix=f.placement_matrix_source_units;
    if(matrix!==undefined&&matrix!==null&&(!Array.isArray(matrix)||matrix.length!==16||matrix.some((v:any)=>typeof v!=='number'||!Number.isFinite(v))||[3,7,11].some(i=>Math.abs(matrix[i])>1e-12)||Math.abs(matrix[15]-1)>1e-12))throw Error('Неверная матрица размещения');
    if(!matrix&&(!Array.isArray(f.translation)||f.translation.length!==3||f.translation.some((v:any)=>typeof v!=='number'||!Number.isFinite(v))))throw Error('Размещение фрагмента не прочитано');
    const determinant=matrix?matrix[0]*(matrix[5]*matrix[10]-matrix[9]*matrix[6])-matrix[4]*(matrix[1]*matrix[10]-matrix[9]*matrix[2])+matrix[8]*(matrix[1]*matrix[6]-matrix[5]*matrix[2]):1;
    if(!Number.isFinite(determinant)||determinant===0)throw Error('Вырожденная матрица размещения');
    positions=g.positions.map((p:number[])=>p.map((v,k)=>matrix?(matrix[k]*p[0]+matrix[4+k]*p[1]+matrix[8+k]*p[2]+matrix[12+k])*scale:(v+f.translation[k])*scale));
    if(positions.some(p=>p.some(v=>!Number.isFinite(v)||Math.abs(v)>1e20)))throw Error('Недопустимые преобразованные координаты');
    indices=checked.topology.flatMap(row=>primitive==='triangles'&&determinant<0?[row[0],row[2],row[1]]:row);
    for(const p of positions)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}
    valid=true;
   }catch(error){errorMessage=error instanceof Error?error.message:String(error);positions=[];indices=[];geometryErrors++;sources[sourceIndex].geometry_complete=false;note(errorMessage.includes('Бюджет')?'nwd-memory-budget':'nwd-fragment-rejected',`${namespace}, фрагмент ${f.serialized_id}: ${errorMessage}`,fragmentId);}
   let color:Vec3=[.65,.7,.74],opacity=1,appearanceFallback=true;
   const raw=f.material_raw;
   if(Array.isArray(raw)&&raw.length>=3&&raw.slice(0,3).every((v:any)=>typeof v==='number'&&Number.isFinite(v))&&(raw[12]===undefined||typeof raw[12]==='number'&&Number.isFinite(raw[12]))){appearanceFallback=false;color=raw.slice(0,3).map((v:number)=>Math.max(0,Math.min(1,v))) as Vec3;opacity=Math.max(0,Math.min(1,1-((f.appearance_flags&16)?0:(raw[12]??0))));}
   else if(valid)note('nwd-appearance-fallback',`${namespace}, фрагмент ${f.serialized_id}: цвет или прозрачность не прочитаны; применён нейтральный цвет`,fragmentId);
   if(f.appearance_diagnostic)note('nwd-appearance-recovery',`${namespace}, фрагмент ${f.serialized_id}: ${f.appearance_diagnostic}`,fragmentId);
   if(!owner&&native.elements.length)note('nwd-owner-unresolved',`${namespace}, фрагмент ${f.serialized_id}: исходный владелец не найден; свойства не унаследованы`,fragmentId);
   const position_byte_offset=size;if(valid)size+=positions.length*12;const index_byte_offset=size;if(valid)size+=indices.length*4;
   if(valid)for(let k=0;k<3;k++){low[k]=Math.min(low[k],min[k]);high[k]=Math.max(high[k],max[k]);}
   if(valid&&primitive==='triangles')triangles+=indices.length/3;
   projected.push({f,g,owner,primitive,indices,positions,min,max,valid,position_byte_offset,index_byte_offset,key,namespace,errorMessage,color,opacity,appearanceFallback});
  }
  for(const message of [...(source.diagnostics??[]),...(source.fragments?.diagnostic?[source.fragments.diagnostic]:[]),...(source.logical_model?.diagnostic?[source.logical_model.diagnostic]:[]),...(source.logical_model?.property_diagnostics??[])])note('nwd-partial',String(message));
  diagnostics.push({element_id:'',kind:'nwd-coverage',message:`${namespace}: узлов дерева ${native.elements.length}; фрагментов ${source.fragments?.decoded??0}/${source.fragments?.declared??'не прочитано'}; страницы свойств ${source.logical_model?.decoded_property_slots??0}/${source.logical_model?.declared_property_slots??'не прочитано'}. Единицы ${calibrations[sourceIndex].unit}: ${calibrations[sourceIndex].source_units_decoded?'прочитаны из файла':'допущение пользователя'}.`});
 }
 const failureDetails=diagnostics.filter(d=>['nwd-fragment-rejected','nwd-fragment-identity','nwd-block-unread','nwd-partial'].includes(d.kind)).slice(0,3).map(d=>d.message.slice(0,700)).join(' | ');
 if(!elements.length&&!projected.length)throw Error('NWD: поддержанные данные не прочитаны'+(failureDetails?'. '+failureDetails:''));
 if(!elements.length&&!projected.some(x=>x.valid))throw Error('NWD: нет геометрии, прошедшей проверки, и прочитанного исходного дерева'+(failureDetails?'. '+failureDetails:''));
 if(!low.every(Number.isFinite)){low.splice(0,3,0,0,0);high.splice(0,3,0,0,0);}
 const origin:Vec3=[(low[0]+high[0])/2,(low[1]+high[1])/2,low[2]],binary=new ArrayBuffer(size);
 for(const x of projected){const {f,g,owner}=x;
  if(x.valid){new Float32Array(binary,x.position_byte_offset,x.positions.length*3).set(x.positions.flatMap((p:Vec3)=>p.map((v:number,k:number)=>v-origin[k])));new Uint32Array(binary,x.index_byte_offset,x.indices.length).set(x.indices);}
  const fragmentId=`nwd-fragment:${x.key}:${f.serialized_id}`,nativeProps=owner?.property_sets??{};
  const element:BimElement={id:fragmentId,step_id:f.serialized_id,global_id:owner?.global_id??'',class:owner?.class??(x.primitive==='triangles'?'NwdTriangleFragment':'NwdLineFragment'),hierarchy:['NwdFragment',owner?.class??'NwdGeometryFragment'],name:owner?.name??`Фрагмент NWD #${f.serialized_id}`,role:'element',semantic_kind:'geometry_fragment',storey_id:null,predefined_type:null,materials:owner?.materials??[],
   property_sets:{...nativeProps,'NWD fragment':{'Serialized ID':f.serialized_id,'Owner node index':f.owner_reference,'Owner node ID':owner?.id??null,'Geometry reference':Number.isSafeInteger(f.geometry_index)?f.geometry_index+1:null,'Primitive count':f.primitive_count??null,'Decoded primitive count':x.valid?x.indices.length/(x.primitive==='triangles'?3:2):null,'Primitive count matches':f.primitive_count_matches??null,'Cached bounds match':f.local_bounds_match??null,'Saved bounds (source units)':f.bounds_source_units??null,'Namespace':x.namespace,'Fragment offset':f.record_offset,'Fragment bytes':f.record_bytes,'Geometry offset':g.record_offset,'Geometry bytes':g.record_bytes,'Placement matrix (source units)':f.placement_matrix_source_units??null,'Appearance source':x.appearanceFallback?'neutral_fallback':'saved_material','Interpretation':'Геометрический фрагмент исходного узла; не отдельная единица оборудования'}},quantity_sets:{},
   source:{kind:'explicit',file_sha256:hash,step_id:f.serialized_id},geometry_error:x.valid?null:x.errorMessage||g.diagnostic||'NWD: геометрия не подготовлена или не прошла сверки',
   nwd:{kind:'fragment',namespace:x.namespace,node_index:f.owner_reference,owner_id:owner?.id,native_guid:owner?.nwd?.native_guid,category_name:owner?.nwd?.category_name,property_sources:owner?.nwd?.property_sources},...(owner?.revit?{revit:owner.revit}:{}),
   geometry_evidence:{engine:'uvyazka-nwd',body_source:'NWD fragment',status:f.status,quantity_eligible:false,requires_review:true,reason:'Проверенная геометрия фрагмента не доказывает количество физических объектов или полноту исходного проекта'},
   mesh:x.valid?{primitive:x.primitive as 'triangles'|'lines',bbox_min_m:x.min,bbox_max_m:x.max,position_byte_offset:x.position_byte_offset,index_byte_offset:x.index_byte_offset,vertex_count:x.positions.length,index_count:x.indices.length,representation_id:f.geometry_index+1,styles:[{name:x.appearanceFallback?'Neutral fallback; material unread':'NWD material',color:x.color,opacity:x.opacity}],groups:[{start:0,count:x.indices.length,material_index:0}],source:{kind:'derived',method:'NWD geometry + source placement matrix + explicit unit conversion',version:'3',representation_id:f.geometry_index+1}}:null};
  elements.push(element);if(owner)relationships.push({step_id:f.serialized_id,class:'NwdFragmentOwnership',parent_id:owner.id,child_ids:[fragmentId]});
 }
 if(recoveryCounts.size)diagnostics.push({element_id:'',kind:'nwd-recovery-summary',message:'Частичное чтение NWD: '+[...recoveryCounts].map(([kind,count])=>`${kind}: ${count}`).join('; ')+`. Подробности: первые ${Math.min(recoveryDetails,200)} сообщений. Пропуски не подтверждают отсутствие объектов в проекте.`});
 const unread=result.unsupported_features??['saved viewpoints','clash results','TimeLiner','rendered textures'];
 diagnostics.push({element_id:'',kind:'nwd-limitations',message:'Не прочитаны или не отображаются: '+unread.join(', ')+'. Фрагменты не считаются оборудованием.'});
 const model:ModelPackage={contract:'ModelPackage',contract_version:'0.1.0',model_id:id,importer_version:'uvyazka-nwd-v4',source:{filename,sha256:hash,size_bytes:result.container.source_bytes,schema:`navisworks:${result.container.serialization_version??431}`,format:/\.nwc$/i.test(filename)?'nwc':'nwd',exported_at:'',exporter:'uvyazka-independent-nwd',calibration:calibrations.length===1?calibrations[0]:undefined,calibrations},coordinate_system:{length_to_m:calibrations.length===1?calibrations[0].length_to_m:1,render_origin_m:origin,up_axis:'Z',bounds_min_m:low,bounds_max_m:high},elements,storeys:[],relationships,diagnostics,
  nwd:{logical_nodes:logicalCount,fragments:fragmentCount,source_models:sources,unread_features:unread},statistics:{products:elements.length,physical_elements:0,meshes:projected.filter(x=>x.valid).length,triangles,geometry_errors:geometryErrors,binary_bytes:size},capabilities:{read:true,geometry_ready:projected.some(x=>x.valid),technology_resolved:false,schedule_ready:false}};
 return {model,binary};
}
