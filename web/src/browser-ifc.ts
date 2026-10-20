/** Browser IFC adapter. Source quantities and GPU geometry stay distinct. */
import type { BimElement, ModelPackage, Vec3 } from './model';

export const value = (x: any): any => x && typeof x === 'object' && 'value' in x ? x.value : x;
export const ids = (x: any): number[] => (Array.isArray(x) ? x : x ? [x] : []).map(value).filter(Number.isInteger);
type Quantity = { value: number; unit: string; kind: string; method: string; [key: string]: unknown };
type Element = BimElement & { quantities: Record<string, Quantity>; measured_quantities: Record<string, unknown> };
type Schema = Record<string, string[]>;
const prefixes: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: .1, CENTI: .01, MILLI: .001, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };

export function geometryEvidence(psets: Record<string, Record<string, unknown>>, converted: boolean): BimElement['geometry_evidence'] {
  const carrier=psets.RvtElementRecordGeometry;
  if(!converted&&!carrier)return undefined;
  const body=typeof carrier?.BodySource==='string'?carrier.BodySource:null;
  // Same reviewed allowlist as the native importer; new body kinds fail closed.
  const decoded=new Set(['partition_wall_centreline','partition_wall_centreline_layer_joins','partition_wall_arc','partition_wall_tapered_section','partition_beam_axis','partition_pipe_axis','partition_stair_run_sketch','partition_roof_slope','family_type_i_section','saved_graphics_mesh']);
  const eligible=!!body&&(decoded.has(body)||(body==='partition_element_record_bbox'&&carrier?.ProfileResolved===true));
  return {engine:'rvt-rs',body_source:body,status:eligible?'decoded_approximation':body&&/box|bbox/.test(body)?'bounding_box':'unknown',quantity_eligible:eligible,requires_review:true,reason:eligible?'Геометрия восстановлена экспериментальным RVT-декодером':'Габаритный блок или неизвестное происхождение тела: объём и площадь работ недоступны'};
}

export function unitScale(unit: any, read: (id: number) => any, type: (code: number) => string, seen = new Set<number>()): number | null {
  if (!unit || seen.has(unit.expressID)) return null;
  seen.add(unit.expressID);
  const name = value(unit.Name), prefix = value(unit.Prefix);
  if (type(unit.type) === 'IFCSIUNIT') {
    const factor = prefix == null ? 1 : prefixes[prefix];
    if (factor === undefined) return null;
    const power = ({ METRE: 1, SQUARE_METRE: 2, CUBIC_METRE: 3 } as Record<string, number>)[name];
    return power ? factor ** power : name === 'GRAM' ? factor / 1000 : null;
  }
  // Offset units and context-dependent units are deliberately unresolved.
  if (type(unit.type) === 'IFCCONVERSIONBASEDUNIT') {
    const conversion = read(value(unit.ConversionFactor));
    const base = unitScale(read(value(conversion?.UnitComponent)), read, type, seen);
    const amount = value(conversion?.ValueComponent);
    return base !== null && Number.isFinite(amount) && amount > 0 ? base * amount : null;
  }
  return null;
}

/** Measurements before float32 packing; no volume from open/non-manifold meshes. */
export function measureMesh(vertices: number[], indices: number[]) {
  const q = (n: number, unit: string, method: string): Quantity => ({ value: n, unit, kind: 'derived', method });
  let surface = 0, side = 0, plan = 0, soffit = 0, volume = 0;
  const edges = new Map<string, { count: number; balance: number }>();
  // Weld shared positions at 0.1 micrometre, independently of tessellator indices.
  const key = (i: number) => vertices.slice(i * 3, i * 3 + 3).map(n => Math.round(n * 1e7)).join(',');
  const origin = vertices.slice(0, 3);
  for (let k = 0; k < indices.length; k += 3) {
    const ii = indices.slice(k, k + 3);
    const [a,b,c] = ii.map(i => vertices.slice(i*3,i*3+3).map((n,j)=>n-origin[j]));
    const ab=b.map((n,j)=>n-a[j]), ac=c.map((n,j)=>n-a[j]);
    const cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    const norm=Math.hypot(...cross); if(norm<1e-14)continue;
    const area=norm/2,nz=cross[2]/norm;surface+=area;plan+=area*Math.abs(nz)/2;
    if(Math.abs(nz)<.5)side+=area;if(nz<-.5)soffit+=area;
    volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    for(const [u,v] of [[ii[0],ii[1]],[ii[1],ii[2]],[ii[2],ii[0]]]) {
      const x=key(u),y=key(v),sign=x<y?1:-1,id=x<y?x+'|'+y:y+'|'+x;
      const edge=edges.get(id)||{count:0,balance:0};edge.count++;edge.balance+=sign;edges.set(id,edge);
    }
  }
  const closed=edges.size>0&&[...edges.values()].every(e=>e.count===2&&e.balance===0);
  const result: Record<string, any> = {surface_area:q(surface,'m2','mesh_triangle_area'),side_area:q(side/2,'m2','half_vertical_surface'),plan_area:q(plan,'m2','half_projected_horizontal_surface'),form_sides:q(side,'m2','mesh_vertical_contact'),form_soffit:q(soffit,'m2','mesh_downward_contact'),mesh_closed:closed};
  if(closed&&Math.abs(volume)>1e-10)result.volume=q(Math.abs(volume),'m3','closed_mesh_signed_tetrahedra');
  return result;
}

export async function importIfc(api: any, data: Uint8Array, filename: string, sha256: string, schemas: Record<string, Schema>, progress: (text: string)=>void, converted=false,memoryMiB=1024): Promise<{model: ModelPackage; binary: ArrayBuffer}> {
  if(![512,1024,2048].includes(memoryMiB))throw Error('Недопустимый бюджет памяти IFC-декодера');
  const handle=api.OpenModel(data,{COORDINATE_TO_ORIGIN:false,MEMORY_LIMIT:memoryMiB*1024*1024,CIRCLE_SEGMENTS:24});
  if(handle<0)throw Error('IFC не открыт: неподдерживаемый формат или повреждённый файл');
  try {
    const schema=api.GetModelSchema(handle),hierarchy=schemas[schema];
    if(!hierarchy)throw Error('Неподдерживаемая схема IFC: '+schema);
    const type=(code:number)=>api.GetNameFromTypeCode(code).toUpperCase();
    const read=(id:number)=>Number.isInteger(id)?api.GetLine(handle,id,false):null;
    const lines=(name:string):any[]=>{const vector=api.GetLineIDsWithType(handle,api.GetTypeCodeFromName(name));return Array.from({length:vector.size()},(_,i)=>read(vector.get(i)));};
    const diagnostics: ModelPackage['diagnostics']=[];
    const warn=(id:string,kind:string,message:string)=>diagnostics.push({element_id:id,kind,message});
    const assignments=lines('IFCUNITASSIGNMENT');
    if(assignments.length!==1)throw Error('Единицы IFC неоднозначны: ожидается одна IfcUnitAssignment');
    const units=new Map<string,any>();for(const id of ids(assignments[0].Units)){const u=read(id);units.set(value(u.UnitType),u);}
    const length=unitScale(units.get('LENGTHUNIT'),read,type);
    if(length===null)throw Error('Не определена единица длины IFC; геометрия не будет выдана за метры');
    const byId=new Map<number,Element>();
    for(const code of api.GetIfcEntityList(handle)) {
      const chain=hierarchy[type(code)];if(!chain?.includes('IfcProduct'))continue;
      const vector=api.GetLineIDsWithType(handle,code);
      for(let i=0;i<vector.size();i++) {
        const id=vector.get(i),row=read(id),role=chain.includes('IfcFeatureElement')?'feature':chain.includes('IfcElement')?'element':chain.includes('IfcSpace')?'space':chain.includes('IfcSpatialElement')||chain.includes('IfcSpatialStructureElement')?'spatial':'other';
        byId.set(id,{id:String(id),step_id:id,global_id:value(row.GlobalId)||'',class:chain[0],hierarchy:chain,name:value(row.Name)||'#'+id,role,storey_id:null,predefined_type:value(row.PredefinedType)||null,materials:[],property_sets:{},quantity_sets:{},quantities:{},measured_quantities:{},source:{kind:'explicit',file_sha256:sha256,step_id:id},mesh:null,geometry_error:null});
      }
    }
    const elements=[...byId.values()];
    if(!elements.length)throw Error('В IFC нет объектов IfcProduct');
    progress(`Чтение свойств: ${elements.length} объектов`);
    const props=(row:any,target:Element)=>{
      const name=value(row?.Name);if(!name)return;
      if(type(row.type)==='IFCPROPERTYSET') {
        const pset:Record<string,unknown>={};for(const id of ids(row.HasProperties)){const p=read(id);if(type(p.type)==='IFCPROPERTYSINGLEVALUE')pset[value(p.Name)]=value(p.NominalValue);}
        target.property_sets[name]={...target.property_sets[name],...pset};
      } else if(type(row.type)==='IFCELEMENTQUANTITY') {
        const raw:Record<string,unknown>={};
        for(const id of ids(row.Quantities)) {
          const q=read(id),spec=({IFCQUANTITYLENGTH:['LengthValue','LENGTHUNIT','m'],IFCQUANTITYAREA:['AreaValue','AREAUNIT','m2'],IFCQUANTITYVOLUME:['VolumeValue','VOLUMEUNIT','m3'],IFCQUANTITYWEIGHT:['WeightValue','MASSUNIT','kg']} as Record<string,string[]>)[type(q.type)];
          if(!spec)continue;
          const amount=value(q[spec[0]]),u=q.Unit?read(value(q.Unit)):units.get(spec[1]),factor=unitScale(u,read,type);
          raw[value(q.Name)]={source_value:amount,unit_id:u?.expressID??null,value_si:factor===null?null:amount*factor,unit:spec[2]};
          if((name==='BaseQuantities'||/^Qto_.*BaseQuantities$/.test(name))&&factor!==null&&Number.isFinite(amount)&&amount>0)target.quantities[value(q.Name)]={value:amount*factor,unit:spec[2],kind:'explicit',method:'ifc_base_quantity',quantity_id:id,quantity_set:name,unit_id:u.expressID,source_value:amount};
          else if(factor===null)warn(target.id,'unknown_quantity_unit',`${name}.${value(q.Name)}: единица не определена`);
        }
        target.quantity_sets[name]=raw;
      }
    };
    const typed=lines('IFCRELDEFINESBYTYPE');
    for(const relation of typed){const t=read(value(relation.RelatingType));for(const id of ids(relation.RelatedObjects)){const e=byId.get(id);if(!e)continue;for(const p of ids(t?.HasPropertySets))props(read(p),e);if(!e.predefined_type)e.predefined_type=value(t?.PredefinedType)||null;}}
    for(const relation of lines('IFCRELDEFINESBYPROPERTIES'))for(const id of ids(relation.RelatedObjects)){const e=byId.get(id);if(e)for(const p of ids(relation.RelatingPropertyDefinition))props(read(p),e);}
    const materialNames=(id:number,seen=new Set<number>(),depth=0):string[]=>{
      if(seen.has(id)||depth>16)return [];seen.add(id);const m=read(id);if(!m)return [];
      if(type(m.type)==='IFCMATERIAL')return [String(value(m.Name)||'')].filter(Boolean);
      return ['Materials','ForLayerSet','MaterialLayers','Material','ForProfileSet','MaterialProfiles','MaterialConstituents'].flatMap(key=>ids(m[key]).flatMap(n=>materialNames(n,seen,depth+1)));
    };
    const materials=new Map<number,string[]>();for(const rel of lines('IFCRELASSOCIATESMATERIAL'))for(const id of ids(rel.RelatedObjects))materials.set(id,materialNames(value(rel.RelatingMaterial)));
    for(const rel of typed)for(const id of ids(rel.RelatedObjects)){const e=byId.get(id);if(e)e.materials=materials.get(value(rel.RelatingType))||[];}
    for(const [id,names] of materials){const e=byId.get(id);if(e)e.materials=[...new Set([...e.materials,...names])];}
    const relationships:ModelPackage['relationships']=[];
    for(const [name,parent,children] of [['IfcRelAggregates','RelatingObject','RelatedObjects'],['IfcRelNests','RelatingObject','RelatedObjects'],['IfcRelVoidsElement','RelatingBuildingElement','RelatedOpeningElement'],['IfcRelFillsElement','RelatingOpeningElement','RelatedBuildingElement'],['IfcRelContainedInSpatialStructure','RelatingStructure','RelatedElements'],['IfcRelAssignsToGroup','RelatingGroup','RelatedObjects']]) {
      for(const rel of lines(name.toUpperCase()))relationships.push({step_id:rel.expressID,class:name,parent_id:String(value(rel[parent])),child_ids:ids(rel[children]).map(String)});
    }
    const systems:{id:string;name:string;class:string;member_ids:string[];connectivity_verified:false}[]=[];
    for(const code of api.GetIfcEntityList(handle))if(hierarchy[type(code)]?.includes('IfcSystem')){
      const vector=api.GetLineIDsWithType(handle,code);
      for(let i=0;i<vector.size();i++){const id=vector.get(i),row=read(id);systems.push({id:String(id),name:String(value(row.Name)||''),class:hierarchy[type(code)][0],member_ids:relationships.filter(r=>r.class==='IfcRelAssignsToGroup'&&r.parent_id===String(id)).flatMap(r=>r.child_ids).filter(id=>byId.get(Number(id))?.role==='element'),connectivity_verified:false});}
    }
    const storeys=elements.filter(e=>e.class==='IfcBuildingStorey').map(e=>({id:e.id,name:e.name,elevation_m:Number.isFinite(value(read(e.step_id).Elevation))?value(read(e.step_id).Elevation)*length:null,placement_origin_m:null,element_count:0}));
    const parent=new Map<string,string>();for(const r of relationships.filter(r=>['IfcRelAggregates','IfcRelContainedInSpatialStructure'].includes(r.class)))for(const id of r.child_ids)parent.set(id,r.parent_id);
    for(const e of elements){let p=parent.get(e.id);const seen=new Set<string>();while(p&&!seen.has(p)){seen.add(p);const storey=storeys.find(s=>s.id===p);if(storey){e.storey_id=p;storey.element_count++;break;}p=parent.get(p);}}
    for(const e of elements){
      const evidence=geometryEvidence(e.property_sets,converted);if(evidence)e.geometry_evidence=evidence;
      const tag=value(read(e.step_id).Tag);
      if(converted&&tag!=null)e.revit={element_id:String(tag),phase_status:'unavailable'};
    }
    // Undo web-ifc's fixed IFC Z-up -> Y-up transform; keep our contract Z-up.
    api.SetGeometryTransformation(handle,[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1]);
    const meshes=new Map<string,{vertices:number[];indices:number[]}>();
    const geometryVisited=new Set<number>();progress('Геометрия: чтение сеток');
    api.StreamAllMeshes(handle,(flat:any)=>{
      const e=byId.get(flat.expressID);if(!e)return;
      const vertices:number[]=[],indices:number[]=[],styles:any[]=[],groups:any[]=[];
      for(let g=0;g<flat.geometries.size();g++){
        const placed=flat.geometries.get(g),geometry=api.GetGeometry(handle,placed.geometryExpressID);
        try {
          const points=api.GetVertexArray(geometry.GetVertexData(),geometry.GetVertexDataSize()),faces=api.GetIndexArray(geometry.GetIndexData(),geometry.GetIndexDataSize()),t=placed.flatTransformation,offset=vertices.length/3,start=indices.length;
          for(let i=0;i<points.length;i+=6){const x=points[i],y=points[i+1],z=points[i+2];const v=[t[0]*x+t[4]*y+t[8]*z+t[12],t[1]*x+t[5]*y+t[9]*z+t[13],t[2]*x+t[6]*y+t[10]*z+t[14]];if(!v.every(Number.isFinite))throw Error('Неконечные координаты IFC');vertices.push(...v);}
          for(const face of faces){if(face>=points.length/6)throw Error('Некорректный индекс треугольника');indices.push(face+offset);}
          const c=placed.color;styles.push({name:'IFC style',color:[c.x,c.y,c.z],opacity:c.w});groups.push({start,count:faces.length,material_index:styles.length-1});
        }finally{geometry.delete();}
      }
      if(indices.length&&vertices.length){
        const low:Vec3=[Infinity,Infinity,Infinity],high:Vec3=[-Infinity,-Infinity,-Infinity];for(let i=0;i<vertices.length;i++){low[i%3]=Math.min(low[i%3],vertices[i]);high[i%3]=Math.max(high[i%3],vertices[i]);}
        e.mesh={bbox_min_m:low,bbox_max_m:high,position_byte_offset:0,index_byte_offset:0,vertex_count:vertices.length/3,index_count:indices.length,representation_id:e.step_id,styles,groups,source:{kind:'derived',method:'web-ifc-tessellation',version:'0.0.78',representation_id:e.step_id}};
        if(e.geometry_evidence?.quantity_eligible!==false)e.measured_quantities=measureMesh(vertices,indices);
        meshes.set(e.id,{vertices,indices});
      }
      geometryVisited.add(flat.expressID);
      if(geometryVisited.size%100===0)progress(`Геометрия: обработано ${geometryVisited.size} объектов, ${meshes.size} с сетками`);
    },true);
    progress(`Геометрия: обработано ${geometryVisited.size} объектов, ${meshes.size} с сетками`);
    const visible=elements.filter(e=>e.mesh&&e.role==='element');
    if(!visible.length)throw Error('Не получена геометрия физических элементов IFC');
    const low:Vec3=[Infinity,Infinity,Infinity],high:Vec3=[-Infinity,-Infinity,-Infinity];
    for(const e of visible)for(let i=0;i<3;i++){low[i]=Math.min(low[i],e.mesh!.bbox_min_m[i]);high[i]=Math.max(high[i],e.mesh!.bbox_max_m[i]);}
    const origin:Vec3=[(low[0]+high[0])/2,(low[1]+high[1])/2,low[2]];
    let byteLength=0;for(const e of elements)if(e.mesh){e.mesh.position_byte_offset=byteLength;byteLength+=e.mesh.vertex_count*12;e.mesh.index_byte_offset=byteLength;byteLength+=e.mesh.index_count*4;}
    const binary=new ArrayBuffer(byteLength);
    for(const e of elements){if(e.mesh){const raw=meshes.get(e.id)!;new Float32Array(binary,e.mesh.position_byte_offset,raw.vertices.length).set(raw.vertices.map((n,i)=>n-origin[i%3]));new Uint32Array(binary,e.mesh.index_byte_offset,raw.indices.length).set(raw.indices);}else if(e.role==='element'){e.geometry_error='No tessellated body';warn(e.id,'geometry_missing','Объект прочитан без геометрии и исключён из геометрического планирования');}}
    warn('','validation_scope','Схема и геометрия прочитаны web-ifc; EXPRESS-проверка не выполнялась. Координаты связей и общие координаты не подтверждены.');
    if(converted)warn('','phases_unavailable','Стадии RVT в браузере пока не прочитаны: существующие и демонтируемые элементы автоматически не исключаются.');
    return {binary,model:{contract:'ModelPackage',contract_version:'0.1.0',importer_version:'web-ifc-0.0.78/uvyazka-1',model_id:sha256,source:{filename,sha256,size_bytes:data.byteLength,schema,exported_at:'',exporter:'web-ifc-0.0.78'},coordinate_system:{length_to_m:length,render_origin_m:origin,up_axis:'Z',bounds_min_m:low,bounds_max_m:high},storeys,elements,relationships,systems,diagnostics,statistics:{products:elements.length,physical_elements:elements.filter(e=>e.role==='element').length,meshes:meshes.size,triangles:[...meshes.values()].reduce((n,m)=>n+m.indices.length/3,0),geometry_errors:elements.filter(e=>e.geometry_error).length,binary_bytes:byteLength},capabilities:{read:true,geometry_ready:true,technology_resolved:false,schedule_ready:false}}};
  }finally{api.CloseModel(handle);}
}
