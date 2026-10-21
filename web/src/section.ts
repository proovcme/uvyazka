import type {ModelPackage,Vec3} from './model';
/** Plane in renderer coordinates (Y up), signed distance >= 0 is visible. */
export function sectionPlane(c:ModelPackage['coordinate_system'],axis:'X'|'Y'|'Z',fraction:number,reverse=false){
 const k={X:0,Y:1,Z:2}[axis];if(!Number.isFinite(fraction))throw Error('Неверное положение сечения');
 const value=c.bounds_min_m[k]+(c.bounds_max_m[k]-c.bounds_min_m[k])*Math.max(0,Math.min(1,fraction));
 const normals:Record<string,Vec3>={X:[-1,0,0],Y:[0,0,1],Z:[0,-1,0]};
 return {value,normal:normals[axis].map(n=>n*(reverse?-1:1)) as Vec3,constant:(value-c.render_origin_m[k])*(reverse?-1:1)};
}
