import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lesTarget,geometryTarget,exactObjectJson} from '../src/les-source.ts';
import type {ModelPackage,BimElement} from '../src/model.ts';
const target={project:'example',dataset:'snapshot',object:'elements:42',sha256:'a'.repeat(64)};
const element={id:'mesh42',source:{file_sha256:target.sha256},revit:{element_id:'42'}} as BimElement;
const model={project_id:'example',source:{format:'rvt'},elements:[element]} as ModelPackage;
test('handoff pins the exact project snapshot object and source hash',()=>{
  const url=new URL('http://127.0.0.1:8765/simulation/');
  url.search=new URLSearchParams({project:target.project,les_dataset:target.dataset,les_object:target.object,les_sha256:target.sha256}).toString();
  assert.deepEqual(lesTarget(url),target);
  url.searchParams.set('les_sha256','bad');assert.throws(()=>lesTarget(url));
});
test('native focus requires the same revision, project, and one unambiguous geometry target',()=>{
  const record={section:'elements',native_id:'42'};
  assert.equal(geometryTarget(model,target,record),'mesh42');
  assert.equal(geometryTarget(model,{...target,sha256:'b'.repeat(64)},record),null);
  assert.equal(geometryTarget(model,{...target,project:'other'},record),null);
  assert.equal(geometryTarget({...model,elements:[element,element]},target,record),null);
  assert.equal(geometryTarget(model,target,{section:'types',native_id:'42'}),null);
});
test('large native integer properties remain exact and quoted strings are unchanged',()=>{
  assert.deepEqual(exactObjectJson('{"big":9007199254740993,"zero":0,"null":null,"name":"ID 9007199254740993"}'),
    {big:'9007199254740993',zero:0,null:null,name:'ID 9007199254740993'});
});
