import test from 'node:test';
import assert from 'node:assert/strict';
import {dataRows,dataSnapshot,parameterCsv,rowQuantities} from '../src/model-data.ts';
import type {ModelPackage} from '../src/model.ts';

function fixture():ModelPackage{return {model_id:'sample',source:{filename:'public.ifc',sha256:'source-hash'},statistics:{physical_elements:1,products:2,geometry_errors:0},storeys:[{id:'L1',name:'Первый',elevation_m:0}],elements:[
  {id:'wall',name:'=unsafe',global_id:'gid-wall',role:'element',class:'IfcWall',storey_id:'L1',source:{file_sha256:'original-source'},mesh:{},
   property_sets:{Pset:{Count:0,Missing:null}},quantities:{Area:{value:12,unit:'m2',kind:'explicit'}},measured_quantities:{Area:{value:15,unit:'m2',kind:'derived'}}},
  {id:'space',name:'Архив',global_id:'gid-room',role:'space',class:'IfcSpace',storey_id:'L1',source:{file_sha256:'room-source'},mesh:null,quantity_sets:{BaseQuantities:{NetFloorArea:0}}}],systems:[]} as unknown as ModelPackage;}

test('rooms are distinct from elements; unknown systems and zero elevations are retained',()=>{
  const model=fixture();assert.equal(dataRows(model,'rooms').length,1);assert.equal(dataRows(model,'elements').length,1);
  assert.equal(dataRows(model,'storeys')[0].level,'0 м');assert.deepEqual(dataRows(model,'systems'),[]);
  const data=dataSnapshot(model,'rooms',dataRows(model,'rooms'));assert.equal(data.coverage.rooms,1);assert.equal(data.coverage.exported_rows,1);
  assert.equal('mesh' in data.records[0],false);assert.match(data.interpretation,/not an accepted/);
});
test('parameter export preserves separate explicit/derived units, original hashes, null and zero',()=>{
  const model=fixture(),csv=parameterCsv(model,dataRows(model,'elements'));
  assert.match(csv,/"original-source"/);assert.match(csv,/"property_sets.Pset.Count","0"/);assert.match(csv,/"property_sets.Pset.Missing","null"/);
  assert.match(csv,/"quantities.Area","12","m2","explicit"/);assert.match(csv,/"measured_quantities.Area","15","m2","derived"/);
  assert.match(csv,/'=unsafe/);
});
test('quantity preview shows explicit zero and never substitutes mesh areas or unknown units',()=>{
  const row=dataRows(fixture(),'elements')[0];
  assert.equal(rowQuantities(row),'Area: 12 m2');
  row.record.source_quantities={Custom:{Area:{value:0,unit:'m2',kind:'explicit'}}};assert.equal(rowQuantities(row),'Area: 0 m2');
  row.record.source_quantities={};row.record.quantity_sets={Raw:{Area:100}};row.record.quantities={};
  assert.match(rowQuantities(row),/не прочитаны/);
});
