/** Read-only geometric diagnostics. Thresholds are not engineering acceptance. */
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const norm2=v=>dot(v,v);
function segmentDistance2(p,a,b){const ab=sub(b,a),length=norm2(ab),t=length?Math.max(0,Math.min(1,dot(sub(p,a),ab)/length)):0;return norm2(p.map((v,i)=>v-a[i]-t*ab[i]));}
export function triangleDistance2(p,a,b,c){
 const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
 const cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
 if(norm2(cross)<=Number.EPSILON**2*Math.max(norm2(ab)*norm2(ac),Number.MIN_VALUE))return Math.min(segmentDistance2(p,a,b),segmentDistance2(p,b,c),segmentDistance2(p,c,a));
 if(d1<=0&&d2<=0)return norm2(ap);
 const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);
 if(d3>=0&&d4<=d3)return norm2(bp);
 const vc=d1*d4-d3*d2;
 if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);return norm2(p.map((x,i)=>x-a[i]-v*ab[i]));}
 const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);
 if(d6>=0&&d5<=d6)return norm2(cp);
 const vb=d5*d2-d1*d6;
 if(vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);return norm2(p.map((x,i)=>x-a[i]-w*ac[i]));}
 const va=d3*d6-d5*d4;
 if(va<=0&&d4-d3>=0&&d5-d6>=0){const w=(d4-d3)/(d4-d3+d5-d6);return norm2(p.map((x,i)=>x-b[i]-w*(c[i]-b[i])));}
 const denominator=1/(va+vb+vc),v=vb*denominator,w=vc*denominator;
 return Math.max(0,norm2(p.map((x,i)=>x-a[i]-v*ab[i]-w*ac[i])));
}
export function worldMesh(model,binary,element){
 const m=element.mesh;if(!m||(m.primitive&&m.primitive!=='triangles'))return null;
 const raw=new Float32Array(binary,m.position_byte_offset,m.vertex_count*3),indices=new Uint32Array(binary,m.index_byte_offset,m.index_count);
 if(indices.length%3||indices.some(i=>i>=m.vertex_count))throw Error('Invalid triangle indices');
 const origin=model.coordinate_system.render_origin_m,points=Array.from({length:m.vertex_count},(_,i)=>[0,1,2].map(k=>raw[i*3+k]+origin[k]));
 if(points.some(p=>p.some(v=>!Number.isFinite(v))))throw Error('Non-finite reference geometry');
 const triangles=Array.from({length:indices.length/3},(_,i)=>[points[indices[i*3]],points[indices[i*3+1]],points[indices[i*3+2]]]);
 return {points,triangles};
}
export function sampledSurfaceDistance(a,b,budget=32){
 if(!Number.isInteger(budget)||budget<1||budget>4096)throw Error('Invalid sampling budget');
 if(!a||!b||!a.points.length||!b.points.length||!a.triangles.length||!b.triangles.length)return null;
 const distances=(from,to)=>{
  const count=Math.min(budget,from.points.length),out=[];
  for(let i=0;i<count;i++){
   const p=from.points[count===1?0:Math.round(i*(from.points.length-1)/(count-1))];let best=Infinity;
   for(const [x,y,z]of to.triangles){best=Math.min(best,triangleDistance2(p,x,y,z));if(best<1e-20)break;}
   out.push(Math.sqrt(best));
  }
  return {samples:count,max_m:Math.max(...out),mean_m:out.reduce((a,b)=>a+b,0)/count};
 };
 const forward=distances(a,b),reverse=distances(b,a);
 return {forward,reverse,max_m:Math.max(forward.max_m,reverse.max_m),method:'deterministic_vertex_samples_to_all_triangles_both_directions',not_full_hausdorff:true};
}
export function bboxDifference(a,b){
 const sides=['bbox_min_m','bbox_max_m'];
 return {max_m:Math.max(...sides.flatMap(side=>[0,1,2].map(k=>Math.abs(a[side][k]-b[side][k])))),
  center_delta_m:[0,1,2].map(k=>(a.bbox_min_m[k]+a.bbox_max_m[k]-b.bbox_min_m[k]-b.bbox_max_m[k])/2),
  size_delta_m:[0,1,2].map(k=>a.bbox_max_m[k]-a.bbox_min_m[k]-b.bbox_max_m[k]+b.bbox_min_m[k])};
}
