import test from 'node:test';
import assert from 'node:assert/strict';
import { unitScale, measureMesh, geometryEvidence } from '../src/browser-ifc.ts';

test('RVT body evidence rejects unknown kinds and bbox takeoff',()=>{
  const evidence=(body:string,profile=false)=>geometryEvidence({RvtElementRecordGeometry:{BodySource:body,ProfileResolved:profile}},false);
  assert.equal(evidence('future_unreviewed_solid')?.quantity_eligible,false);
  assert.equal(evidence('partition_element_record_bbox')?.quantity_eligible,false);
  assert.equal(evidence('partition_element_record_bbox',true)?.quantity_eligible,true);
  assert.equal(evidence('saved_graphics_mesh')?.quantity_eligible,true);
  assert.equal(geometryEvidence({},true)?.quantity_eligible,false);
});

test('IFC units: prefix powers, mass, explicit conversion and unknown',()=>{
  const read=(id:number):any=>({1:{ValueComponent:{value:.3048},UnitComponent:{value:2}},2:{expressID:2,type:1,Name:{value:'METRE'}}}[id]);
  const name=(code:number)=>({1:'IFCSIUNIT',2:'IFCCONVERSIONBASEDUNIT',3:'IFCCONTEXTDEPENDENTUNIT'}[code]!);
  assert.equal(unitScale({expressID:5,type:1,Name:{value:'SQUARE_METRE'},Prefix:{value:'MILLI'}},read,name),1e-6);
  assert.equal(unitScale({expressID:5,type:1,Name:{value:'GRAM'},Prefix:{value:'KILO'}},read,name),1);
  assert.equal(unitScale({expressID:5,type:2,ConversionFactor:{value:1}},read,name),.3048);
  assert.equal(unitScale({expressID:5,type:3,Name:{value:'CUSTOM'}},read,name),null);
  assert.equal(unitScale(null,read,name),null);
});
test('Open triangles never produce a volume; closed translated tetrahedron does',()=>{
  const vertices=[0,0,0,2,0,0,0,3,0,0,0,4];
  assert.equal(measureMesh(vertices,[0,1,2]).volume,undefined);
  const indices=[0,2,1,0,1,3,0,3,2,1,2,3];
  assert.equal(measureMesh(vertices,indices).volume.value,4);
  const far=vertices.map((n,i)=>n+[1000000,2000000,4000][i%3]);
  assert.equal(measureMesh(far,indices).volume.value,4);
  assert.equal(measureMesh(vertices,[...indices,0,2,1]).volume,undefined);
});
