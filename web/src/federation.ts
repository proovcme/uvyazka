import type {ModelPackage, Vec3, BimElement} from './model.ts';
import {validatePackage} from './model.ts';

export interface SceneMember {instanceId:string; model:ModelPackage; binary:ArrayBuffer; offset:Vec3; rotation:number; visible:boolean}
export const MAX_SCENE_BYTES=512*1024**2;
export function federationBudget(members:SceneMember[],maximum=MAX_SCENE_BYTES){
 let bytes=0,inputs=0,elements=0;
 for(const member of members){inputs+=member.binary.byteLength;elements+=member.model.elements.length;for(const element of member.model.elements)if(element.mesh){const mesh=element.mesh;bytes+=mesh.vertex_count*12+mesh.index_count*4;if(!Number.isSafeInteger(bytes)||bytes>maximum)throw Error('Сводная геометрия превышает безопасный бюджет памяти. Откройте меньший состав моделей.');}}
 if(inputs>maximum||elements>2_000_000)throw Error('Состав сцены превышает безопасный бюджет обработки.');return bytes;
}
export function placedPoint(p:Vec3, offset:Vec3, rotation:number):Vec3 {
  const a=rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  return [p[0]*c-p[1]*s+offset[0],p[0]*s+p[1]*c+offset[1],p[2]+offset[2]];
}
/** Federate in source world metres, never align the centres of separate files. */
export async function federate(members:SceneMember[],progress:(text:string)=>void=()=>{}):Promise<{model:ModelPackage;binary:ArrayBuffer}> {
  if(!members.length)throw Error('Добавьте хотя бы одну модель');
  federationBudget(members);let prepared=0,copied=0;
  const ids=new Set<string>();
  const placements=new Map<SceneMember,(vertices:Float32Array,index:number,out:Vec3)=>Vec3>();
  for(const m of members){
    if(ids.has(m.instanceId)||!m.instanceId||m.model.federation)throw Error('Повторный ID или вложенная сводная модель');
    ids.add(m.instanceId);validatePackage(m.model,m.binary);
    if(m.offset.length!==3||![...m.offset,m.rotation].every(Number.isFinite))throw Error('Смещение и поворот должны быть конечными числами');
    // Placement is constant for a source. Keep the original arithmetic order,
    // but do not recompute trigonometry or allocate arrays for every vertex.
    const a=m.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),o=m.model.coordinate_system.render_origin_m,t=m.offset;
    placements.set(m,(v,i,out)=>{const x=v[i]+o[0],y=v[i+1]+o[1];out[0]=x*c-y*s+t[0];out[1]=x*s+y*c+t[1];out[2]=v[i+2]+o[2]+t[2];return out;});
  }
  const records=members.map(m=>({model_id:m.model.model_id,source_sha256:m.model.source.sha256,source_format:m.model.source.format??'ifc',importer_version:m.model.importer_version,instance_id:m.instanceId,label:m.model.source.filename,offset_m:m.offset,rotation_deg:m.rotation,coordinate_alignment_verified:false}));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({version:1,records})))),n=>n.toString(16).padStart(2,'0')).join('');
  const elements:BimElement[]=[],storeys:ModelPackage['storeys']=[],relationships:ModelPackage['relationships']=[],diagnostics:ModelPackage['diagnostics']=[],systems:NonNullable<ModelPackage['systems']>=[];
  const low:Vec3=[Infinity,Infinity,Infinity],high:Vec3=[-Infinity,-Infinity,-Infinity];
  let size=0;
  for(const member of members){
    const source=member.model,prefix=(id:string)=>member.instanceId+':'+id;
    const place=placements.get(member)!,point:Vec3=[0,0,0];
    for(const original of source.elements){
      // Source properties are immutable and may be shared by thousands of NWD
      // fragments. Copy only the placement fields that federation changes.
      const e:BimElement={...original,mesh:original.mesh?{...original.mesh}:null,nwd:original.nwd?{...original.nwd}:undefined};e.id=prefix(e.id);e.storey_id=e.storey_id===null?null:prefix(e.storey_id);
      if(e.nwd?.parent_id)e.nwd.parent_id=prefix(e.nwd.parent_id);if(e.nwd?.owner_id)e.nwd.owner_id=prefix(e.nwd.owner_id);
      e.source_model_id=source.model_id;e.source_instance_id=member.instanceId;e.source_element_id=original.id;e.source_step_id=original.step_id;
      if(e.mesh){
        const mesh=e.mesh;mesh.position_byte_offset=size;size+=mesh.vertex_count*12;mesh.index_byte_offset=size;size+=mesh.index_count*4;
        const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];
        // Transform every vertex: rotated AABB corners overestimate the real bounds.
        const vertices=new Float32Array(member.binary,original.mesh!.position_byte_offset,mesh.vertex_count*3);
        for(let i=0;i<vertices.length;i+=3){
          if(++prepared%65536===0)progress('Проверка размещения: обработано '+prepared+' вершин');
          place(vertices,i,point);
          for(let k=0;k<3;k++){if(!Number.isFinite(point[k]))throw Error('Некорректные координаты геометрии');min[k]=Math.min(min[k],point[k]);max[k]=Math.max(max[k],point[k]);}
        }
        mesh.bbox_min_m=min;mesh.bbox_max_m=max;
        if(mesh.vertex_count)for(let k=0;k<3;k++){low[k]=Math.min(low[k],min[k]);high[k]=Math.max(high[k],max[k]);}
      }
      elements.push(e);
    }
    for(const s of source.storeys)storeys.push({...s,id:prefix(s.id),name:source.source.filename+' · '+s.name,elevation_m:s.elevation_m===null?null:s.elevation_m+member.offset[2],placement_origin_m:s.placement_origin_m?placedPoint(s.placement_origin_m,member.offset,member.rotation):null});
    for(const r of source.relationships)relationships.push({...r,source_instance_id:member.instanceId,parent_id:prefix(r.parent_id),child_ids:r.child_ids.map(prefix)});
    for(const d of source.diagnostics)diagnostics.push({...d,element_id:prefix(d.element_id)});
    for(const s of source.systems??[])systems.push({...s,id:prefix(s.id),member_ids:s.member_ids.map(prefix)});
  }
  const geometryReady=low.every(Number.isFinite);
  if(!geometryReady){if(!elements.some(e=>e.semantic_kind==='source_node'))throw Error('В сцене нет геометрии');low.splice(0,3,0,0,0);high.splice(0,3,0,0,0);}
  const origin:Vec3=[(low[0]+high[0])/2,(low[1]+high[1])/2,low[2]],binary=new ArrayBuffer(size);
  let row=0;
  for(const m of members){const place=placements.get(m)!,world:Vec3=[0,0,0];for(const original of m.model.elements){
    const e=elements[row++];if(!e.mesh||!original.mesh)continue;
    const input=new Float32Array(m.binary,original.mesh.position_byte_offset,e.mesh.vertex_count*3),output=new Float32Array(binary,e.mesh.position_byte_offset,input.length);
    for(let i=0;i<input.length;i+=3){if(++copied%65536===0)progress('Сборка сцены: обработано '+copied+' вершин');place(input,i,world);for(let k=0;k<3;k++)output[i+k]=world[k]-origin[k];}
    new Uint32Array(binary,e.mesh.index_byte_offset,e.mesh.index_count).set(new Uint32Array(m.binary,original.mesh.index_byte_offset,e.mesh.index_count));
  }}
  const model:ModelPackage={contract:'ModelPackage',contract_version:'0.1.0',importer_version:'browser-federation-1',model_id:hash,
    source:{filename:`Сводная модель · ${members.length} файлов`,sha256:hash,size_bytes:members.reduce((n,m)=>n+m.model.source.size_bytes,0),schema:'Federation',format:'federation',exported_at:'',exporter:'uvyazka'},
    coordinate_system:{length_to_m:1,render_origin_m:origin,up_axis:'Z',bounds_min_m:low,bounds_max_m:high},elements,storeys,relationships,diagnostics,systems,
    engineering_links:members.flatMap(m=>(m.model.engineering_links??[]).map(link=>({...link,id:m.instanceId+':'+link.id,from:m.instanceId+':'+link.from,to:m.instanceId+':'+link.to}))),
    federation:{members:records,note:'Исходные координаты в метрах + заданные пользователем смещения и повороты. Совмещение не подтверждено.'},
    ...(members.some(m=>m.model.nwd)?{nwd:{logical_nodes:members.reduce((n,m)=>n+(m.model.nwd?.logical_nodes??0),0),fragments:members.reduce((n,m)=>n+(m.model.nwd?.fragments??0),0),source_models:members.flatMap(m=>(m.model.nwd?.source_models??[]).map(s=>({...s,root_id:s.root_id?m.instanceId+':'+s.root_id:null}))),unread_features:[...new Set(members.flatMap(m=>m.model.nwd?.unread_features??[]))]}}:{}),
    phase_sources:Object.fromEntries(members.map(m=>[m.instanceId,m.model.revit??{status:'unavailable',phases:[]}])),
    statistics:{products:elements.length,physical_elements:elements.filter(e=>e.role==='element'&&e.semantic_kind!=='geometry_fragment').length,meshes:elements.filter(e=>e.mesh).length,triangles:members.reduce((n,m)=>n+m.model.statistics.triangles,0),geometry_errors:elements.filter(e=>e.geometry_error).length,binary_bytes:size},
    capabilities:{read:true,geometry_ready:geometryReady,technology_resolved:false,schedule_ready:false}};
  return {model,binary};
}
