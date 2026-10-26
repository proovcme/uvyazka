import {Vector3,Triangle,Ray} from 'three';
import type {Vec3,ModelPackage,BimElement} from './model';
export function planarArea(points:Vec3[],tolerance=0.001){
 if(points.length<3||!points.flat().every(Number.isFinite))throw Error('Нужно не менее трёх конечных точек');
 const p=points.map(x=>new Vector3(...x)),origin=p[0],normal=new Vector3();
 for(let i=1;i<p.length-1&&normal.lengthSq()<1e-16;i++)normal.crossVectors(p[i].clone().sub(origin),p[i+1].clone().sub(origin));
 if(normal.lengthSq()<1e-16)throw Error('Точки лежат на одной прямой');normal.normalize();
 if(p.some(x=>Math.abs(x.clone().sub(origin).dot(normal))>tolerance))throw Error('Контур не плоский: отклонение больше 1 мм');
 const u=p[1].clone().sub(origin).normalize(),v=new Vector3().crossVectors(normal,u),xy=p.map(x=>{const a=x.clone().sub(origin);return [a.dot(u),a.dot(v)];});
 const cross=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 for(let i=0;i<xy.length;i++)for(let j=i+1;j<xy.length;j++){
  if(j===i+1||i===0&&j===xy.length-1)continue;
  const a=xy[i],b=xy[(i+1)%xy.length],c=xy[j],d=xy[(j+1)%xy.length];
  const ab=[cross(a,b,c),cross(a,b,d)],cd=[cross(c,d,a),cross(c,d,b)];
  if(ab[0]*ab[1]<=0&&cd[0]*cd[1]<=0&&Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))&&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1])))throw Error('Контур самопересекается или касается себя');
 }
 const area=Math.abs(xy.reduce((sum,a,i)=>{const b=xy[(i+1)%xy.length];return sum+a[0]*b[1]-b[0]*a[1];},0))/2;
 if(area<=1e-12)throw Error('Площадь контура не определена');return area;
}
function segments(a:Vector3,b:Vector3,c:Vector3,d:Vector3):[Vector3,Vector3]{
 const u=b.clone().sub(a),v=d.clone().sub(c),w=a.clone().sub(c),aa=u.dot(u),bb=u.dot(v),cc=v.dot(v),dd=u.dot(w),ee=v.dot(w),den=aa*cc-bb*bb;
 let s=den>1e-20?Math.max(0,Math.min(1,(bb*ee-cc*dd)/den)):0,t=cc>1e-20?(bb*s+ee)/cc:0;
 if(t<0){t=0;s=aa>1e-20?Math.max(0,Math.min(1,-dd/aa)):0;}else if(t>1){t=1;s=aa>1e-20?Math.max(0,Math.min(1,(bb-dd)/aa)):0;}
 return [a.clone().addScaledVector(u,s),c.clone().addScaledVector(v,t)];
}
export function triangleClearance(a:Triangle,b:Triangle){
 const aa=[a.a,a.b,a.c],bb=[b.a,b.b,b.c];let best=Infinity,p=new Vector3(),q=new Vector3();
 const keep=(x:Vector3,y:Vector3)=>{const d=x.distanceToSquared(y);if(d<best){best=d;p=x.clone();q=y.clone();}};
 for(const x of aa)keep(x,b.closestPointToPoint(x,new Vector3()));for(const y of bb)keep(a.closestPointToPoint(y,new Vector3()),y);
 for(let i=0;i<3;i++)for(let j=0;j<3;j++)keep(...segments(aa[i],aa[(i+1)%3],bb[j],bb[(j+1)%3]));
 for(const [points,tri]of [[aa,b],[bb,a]]as const)for(let i=0;i<3;i++){const delta=points[(i+1)%3].clone().sub(points[i]),length=delta.length();if(!length)continue;const hit=new Ray(points[i],delta.normalize()).intersectTriangle(tri.a,tri.b,tri.c,false,new Vector3());if(hit&&hit.distanceTo(points[i])<=length+1e-9)keep(hit,hit);}
 return {distance_m:Math.sqrt(best),a:p.toArray()as Vec3,b:q.toArray()as Vec3};
}
export async function meshClearance(model:ModelPackage,binary:ArrayBuffer,a:BimElement,b:BimElement,budget=200000){
 if(a.mesh?.primitive==='lines'||b.mesh?.primitive==='lines')throw Error('Зазор между линейными примитивами пока не поддержан');
 if(!a.mesh||!b.mesh)throw Error('Для обоих элементов нужна геометрия');
 if(a.id===b.id)throw Error('Выберите два разных элемента');
 const count=a.mesh.index_count/3*b.mesh.index_count/3;if(count>budget)throw Error(`Зазор не рассчитан: ${count} пар треугольников превышают лимит ${budget}.`);
 const triangles=(e:BimElement)=>{const m=e.mesh!,vertices=new Float32Array(binary,m.position_byte_offset,m.vertex_count*3),indices=new Uint32Array(binary,m.index_byte_offset,m.index_count),origin=model.coordinate_system.render_origin_m;return Array.from({length:indices.length/3},(_,i)=>new Triangle(...[0,1,2].map(k=>{const index=indices[i*3+k]*3;return new Vector3(vertices[index]+origin[0],vertices[index+1]+origin[1],vertices[index+2]+origin[2]);})as [Vector3,Vector3,Vector3]));};
 let best:{distance_m:number;a:Vec3;b:Vec3}|null=null,n=0;
 const ta=triangles(a),tb=triangles(b);
 for(const x of ta)for(const y of tb){const r=triangleClearance(x,y);if(!best||r.distance_m<best.distance_m)best=r;if(best.distance_m<1e-9)return best;if(++n%2000===0)await new Promise(resolve=>setTimeout(resolve,0));}
 if(!best)throw Error('В сетке нет треугольников');return best;
}
