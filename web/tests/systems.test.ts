import test from 'node:test';
import assert from 'node:assert/strict';
import {systemMembers,systemCoverage,elementSystems} from '../src/systems.ts';
import type {ModelPackage} from '../src/model.ts';

const model={elements:[{id:'a',mesh:{}},{id:'b',mesh:null},{id:'c',mesh:{}}],systems:[
  {id:'s1',name:'В1',member_ids:['a','a','b','missing']},
  {id:'s2',name:'В1',member_ids:['a','c']}
]} as unknown as ModelPackage;

test('system coverage deduplicates explicit membership and preserves missing references',()=>{
  assert.deepEqual(systemCoverage(model,'s1'),{declared:3,present:2,geometry:1,missing:1,withoutGeometry:1});
});
test('identical names do not merge systems; an element may belong to multiple systems',()=>{
  assert.deepEqual([...systemMembers(model,'s2')],['a','c']);
  assert.deepEqual(elementSystems(model,'a').map(s=>s.id),['s1','s2']);
  assert.deepEqual(elementSystems(model,'b').map(s=>s.id),['s1']);
});
test('missing system or absent model produces empty membership',()=>{
  assert.equal(systemMembers(null,'s1').size,0);
  assert.equal(systemMembers(model,'unknown').size,0);
  assert.deepEqual(elementSystems(null,'a'),[]);
  assert.deepEqual(systemCoverage(model,'unknown'),{declared:0,present:0,geometry:0,missing:0,withoutGeometry:0});
});
