import type {ModelPackage,BimElement,Vec3} from './model';
export const nwdUnits={m:1,mm:.001,cm:.01,ft:.3048} as const;
export type NwdUnit=keyof typeof nwdUnits;
/** Geometry fragments are not interpreted as physical BIM objects. Units are an explicit user assumption. */
export async function importNwd(result:any,filename:string,unit:NwdUnit):Promise<{model:ModelPackage;binary:ArrayBuffer}>{
 const scale=nwdUnits[unit];if(!Object.hasOwn(nwdUnits,unit)||typeof scale!=='number')throw Error('Для NWD нужно явно выбрать исходные единицы');
 if(!result.fragments?.rows?.length)throw Error(result.fragments?.diagnostic||'NWD: поддержанные экземпляры не прочитаны');
 const hash=result.container.source_sha256;
 const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['nwd-v1',hash,unit])))),n=>n.toString(16).padStart(2,'0')).join('');
 const low:Vec3=[Infinity,Infinity,Infinity],high:Vec3=[-Infinity,-Infinity,-Infinity];let size=0;
 const projected=result.fragments.rows.map((f:any)=>{
  const g=result.geometry[f.geometry_index];if(!g)throw Error('NWD: ссылка за пределами каталога геометрии');
  const primitive=g.serialized_class===94?'triangles':'lines';
  const indices=(primitive==='triangles'?g.triangles:g.lines).flat() as number[];
  const valid=!g.diagnostic&&f.primitive_count_matches&&f.local_bounds_match&&indices.length>0;
  const positions=g.positions.map((p:number[])=>p.map((v,k)=>(v+f.translation[k])*scale)) as Vec3[];
  if(positions.some(p=>p.some(v=>!Number.isFinite(v)||Math.abs(v)>1e20)))throw Error('NWD: недопустимые преобразованные координаты');
  const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];for(const p of positions)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}
  const position_byte_offset=size;if(valid)size+=positions.length*12;const index_byte_offset=size;if(valid)size+=indices.length*4;
  if(size>256*1024**2)throw Error('NWD: геометрия превышает технический бюджет 256 МиБ');
  if(valid)for(let k=0;k<3;k++){low[k]=Math.min(low[k],min[k]);high[k]=Math.max(high[k],max[k]);}
  return {f,g,primitive,indices,positions,min,max,valid,position_byte_offset,index_byte_offset};
 });
 if(!low.every(Number.isFinite))throw Error('NWD: нет геометрии, прошедшей проверки');
 const origin:Vec3=[(low[0]+high[0])/2,(low[1]+high[1])/2,low[2]],binary=new ArrayBuffer(size),elements:BimElement[]=[];
 for(const x of projected){const {f,g}=x;
  if(x.valid){new Float32Array(binary,x.position_byte_offset,x.positions.length*3).set(x.positions.flatMap((p:Vec3)=>p.map((v:number,k:number)=>v-origin[k])));new Uint32Array(binary,x.index_byte_offset,x.indices.length).set(x.indices);}
  elements.push({id:'nwd:'+f.serialized_id,step_id:f.serialized_id,global_id:'',class:x.primitive==='triangles'?'NwdTriangleFragment':'NwdLineFragment',hierarchy:['NwdFragment',x.primitive==='triangles'?'NwdTriangleFragment':'NwdLineFragment'],name:'Экземпляр NWD #'+f.serialized_id,role:'element',semantic_kind:'geometry_fragment',storey_id:null,predefined_type:null,materials:[],
   property_sets:{NWD:{'Serialized ID':f.serialized_id,'Owner reference (unresolved)':f.owner_reference,'Geometry reference':f.geometry_index+1,'Primitive count':f.primitive_count,'Material reference':f.material_serialized_id,'RGB':f.material_raw.slice(0,3),'Translation (source units)':f.translation,'Source unit (user assumption)':unit,'Fragment offset':f.record_offset,'Fragment bytes':f.record_bytes,'Geometry offset':g.record_offset,'Geometry bytes':g.record_bytes,'Opaque word':f.opaque_word,'Interpretation':'Geometry fragment; BIM object and ownership are not decoded'}},quantity_sets:{},
   source:{kind:'explicit',file_sha256:hash,step_id:f.serialized_id},geometry_error:x.valid?null:g.diagnostic||'NWD: геометрия не прошла проверку границ или количества',
   geometry_evidence:{engine:'uvyazka-nwd',body_source:'NWD fragment',status:f.status,quantity_eligible:false,requires_review:true,reason:'Геометрический экземпляр; единицы заданы пользователем, семантика объекта не прочитана'},
   mesh:x.valid?{primitive:x.primitive as 'triangles'|'lines',bbox_min_m:x.min,bbox_max_m:x.max,position_byte_offset:x.position_byte_offset,index_byte_offset:x.index_byte_offset,vertex_count:x.positions.length,index_count:x.indices.length,representation_id:f.geometry_index+1,styles:[{name:'NWD RGB',color:f.material_raw.slice(0,3).map((v:number)=>Math.max(0,Math.min(1,v))) as Vec3,opacity:1}],groups:[{start:0,count:x.indices.length,material_index:0}],source:{kind:'derived',method:'NWD strip decoder + explicit translation + user scale',version:'1',representation_id:f.geometry_index+1}}:null});
 }
 const model:ModelPackage={contract:'ModelPackage',contract_version:'0.1.0',model_id:id,importer_version:'uvyazka-nwd-v1',source:{filename,sha256:hash,size_bytes:result.container.source_bytes,schema:'navisworks:431',format:'nwd',exported_at:'',exporter:'uvyazka-independent-nwd',calibration:{unit,length_to_m:scale,basis:'user_assumption',source_units_decoded:false}},coordinate_system:{length_to_m:scale,render_origin_m:origin,up_axis:'Z',bounds_min_m:low,bounds_max_m:high},elements,storeys:[],relationships:[],
  diagnostics:[{element_id:'',kind:'nwd-coverage',message:`Геометрические экземпляры: ${result.fragments.decoded}/${result.fragments.declared}. Это не количество оборудования. Единицы ${unit} заданы пользователем. Дерево, BIM-свойства, виды, коллизии и TimeLiner не прочитаны.`},...(result.fragments.diagnostic?[{element_id:'',kind:'partial',message:result.fragments.diagnostic}]:[])],
  statistics:{products:elements.length,physical_elements:0,meshes:elements.filter(e=>e.mesh).length,triangles:projected.filter((x:any)=>x.valid&&x.primitive==='triangles').reduce((n:number,x:any)=>n+x.indices.length/3,0),geometry_errors:elements.filter(e=>!e.mesh).length,binary_bytes:size},capabilities:{read:true,geometry_ready:true,technology_resolved:false,schedule_ready:false}};
 return {model,binary};
}
