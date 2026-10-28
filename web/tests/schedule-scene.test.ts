import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleSceneSelection} from '../src/schedule-scene.ts';
import type {ModelPackage} from '../src/model.ts';
const a='a'.repeat(64),b='b'.repeat(64);
const element=(id:string,revit:string,instance?:string)=>({id,step_id:42,revit:{element_id:revit},source_instance_id:instance,mesh:{},property_sets:{},source:{file_sha256:a}});
test('schedule selection requires the original source hash and explicit ID, never STEP or a similar name',()=>{
 const model={source:{format:'rvt',sha256:a},elements:[element('scene','9007199254740993')]} as unknown as ModelPackage;
 assert.deepEqual(scheduleSceneSelection(model,a,['9007199254740993']).scene_ids,['scene']);
 assert.deepEqual(scheduleSceneSelection(model,b,['9007199254740993']).missing_ids,['9007199254740993']);
 assert.deepEqual(scheduleSceneSelection(model,a,['42']).scene_ids,[]);
 const rounded={...model,elements:[element('rounded',Number.MAX_SAFE_INTEGER+1 as unknown as string)]};assert.deepEqual(scheduleSceneSelection(rounded,a,[String(Number.MAX_SAFE_INTEGER+1)]).scene_ids,[],'an already rounded numeric ID is not an exact identity');
});
test('federation preserves source isolation and intentionally repeated occurrences; ambiguous IDs do not link',()=>{
 const model={source:{sha256:'f'.repeat(64)},federation:{members:[{instance_id:'one',source_sha256:a},{instance_id:'two',source_sha256:a},{instance_id:'other',source_sha256:b}]},elements:[element('a1','10','one'),element('a2','10','two'),element('b1','10','other')]} as unknown as ModelPackage;
 const joined=scheduleSceneSelection(model,a,['10','10']);assert.deepEqual(joined.scene_ids,['a1','a2']);assert.equal(joined.represented,1);
 const duplicate={...model,elements:[...model.elements,element('duplicate','10','one')]};const refused=scheduleSceneSelection(duplicate,a,['10']);assert.deepEqual(refused.ambiguous_ids,['10']);assert.deepEqual(refused.scene_ids,[]);
});
test('unmeshed or unavailable elements are reported without borrowing another file identity',()=>{
 const model={source:{format:'rvt',sha256:a},elements:[{...element('no-geometry','10'),mesh:null}]} as unknown as ModelPackage;
 assert.deepEqual(scheduleSceneSelection(model,a,['10']).missing_ids,['10']);assert.equal(scheduleSceneSelection(null,a,['10']).represented,0);
});
