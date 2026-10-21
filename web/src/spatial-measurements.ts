import type {ModelPackage,Vec3} from './model';
export interface SurfacePoint {element_id:string;point_m:Vec3;triangle_index:number|null}
export type MeasureAxis='distance'|'X'|'Y'|'Z';
export function measurePoints(a:Vec3,b:Vec3,axis:MeasureAxis){
  if(![...a,...b].every(Number.isFinite))throw Error('Координаты замера должны быть конечными');
  const delta=b.map((n,i)=>n-a[i]) as Vec3,distance=Math.hypot(...delta);
  return {delta_m:delta,distance_m:distance,value_m:axis==='distance'?distance:Math.abs(delta[{X:0,Y:1,Z:2}[axis]])};
}
export function measurementRecord(project:string,model:ModelPackage,a:SurfacePoint,b:SurfacePoint,axis:MeasureAxis){
  const source=(p:SurfacePoint)=>{const e=model.elements.find(e=>e.id===p.element_id);if(!e)throw Error('Элемент замера отсутствует в модели');return {...p,source_sha256:e.source.file_sha256,source_model_id:e.source_model_id??model.model_id,source_element_id:e.source_element_id??e.id,global_id:e.global_id,geometry_evidence:e.geometry_evidence??null};};
  return {contract:'SpatialMeasurement',version:1,id:crypto.randomUUID(),created_at:new Date().toISOString(),project_id:project,
    model_id:model.model_id,source_sha256:model.source.sha256,filename:model.source.filename,importer_version:model.importer_version,
    coordinate_system:'scene_world_metres_Z_up',placements:model.federation?.members??[],method:'two_picked_mesh_surface_points',axis,
    review_status:'unreviewed',note:'Между двумя выбранными точками сетки. Не минимальный зазор между телами; точность зависит от исходной геометрии. Проекция на ось не меняет исходные точки.',
    points:[source(a),source(b)],...measurePoints(a.point_m,b.point_m,axis)};
}
export type SpatialMeasurement=ReturnType<typeof measurementRecord>;
export const measurementKey=(project:string)=>'uvyazka:spatial-measurements:v1:'+encodeURIComponent(project);
