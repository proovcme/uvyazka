import test from 'node:test';import assert from 'node:assert/strict';
import {triangleDistance2,sampledSurfaceDistance,worldMesh,bboxDifference} from '../../tools/lib/geometry-reference.mjs';
test('reference metric measures triangle interiors, edges and degenerate segments',()=>{
 const a=[0,0,0],b=[2,0,0],c=[0,2,0];
 assert.equal(triangleDistance2([.5,.5,3],a,b,c),9);
 assert.equal(triangleDistance2([1,1,0],a,b,c),0);
 assert.equal(triangleDistance2([3,0,0],a,b,c),1);
 assert.equal(triangleDistance2([1,2,0],a,b,b),4);
 assert.equal(triangleDistance2([1,2,3],a,a,a),14);
});
test('surface comparison detects reflection with unchanged bounds and tolerates equivalent tessellation',()=>{
 const points=[[0,0,0],[2,0,0],[0,2,0]],mesh={points,triangles:[points]};
 const split={points:[[0,0,0],[2,0,0],[0,2,0],[1,0,0]],triangles:[[[0,0,0],[1,0,0],[0,2,0]],[[1,0,0],[2,0,0],[0,2,0]]]};
 assert.equal(sampledSurfaceDistance(mesh,split).max_m,0);
 const reflected=points.map(p=>[2-p[0],p[1],p[2]]);
 assert.ok(sampledSurfaceDistance(mesh,{points:reflected,triangles:[reflected]}).max_m>1);
 assert.equal(sampledSurfaceDistance(mesh,{points:[],triangles:[]}),null);
});
test('reference uses world origin once and reports signed placement and size deltas',()=>{
 const binary=new ArrayBuffer(48);new Float32Array(binary,0,9).set([0,0,0,1,0,0,0,1,0]);new Uint32Array(binary,36,3).set([0,1,2]);
 const world=worldMesh({coordinate_system:{render_origin_m:[100,200,300]}},binary,{mesh:{position_byte_offset:0,vertex_count:3,index_byte_offset:36,index_count:3}});
 assert.deepEqual(world.points[1],[101,200,300]);
 const a={bbox_min_m:[100,200,300],bbox_max_m:[101,201,300]},b={bbox_min_m:[0,0,0],bbox_max_m:[1,1,0]};
 assert.deepEqual(bboxDifference(a,b).center_delta_m,[100,200,300]);assert.deepEqual(bboxDifference(a,b).size_delta_m,[0,0,0]);
 assert.equal(bboxDifference(a,b).max_m,300);
});
