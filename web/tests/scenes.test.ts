import test from 'node:test';
import assert from 'node:assert/strict';
import { projectState } from '../src/simulation.ts';
import { workScenes } from '../src/scenes.ts';

test('existing elements appear at zero; demolition disappears only on its event',()=>{
  const run:any={scenario:{resources:[],initial_element_ids:['old','removed'],excluded_element_ids:['future'],
    units:[{id:'removed',kind:'demolition',target_ids:['removed'],operation_ids:['demolish']}],
    operations:[{id:'demolish',visual_phase:'work'}]},events:[{time:5,kind:'operation_started',operation_id:'demolish'},
      {time:10,kind:'operation_completed',operation_id:'demolish'}]};
  assert.equal(projectState(run,0).construction.get('old'),'complete');
  assert.equal(projectState(run,0).construction.get('future'),'absent');
  assert.equal(projectState(run,0).construction.get('removed'),'complete');
  assert.equal(projectState(run,7).construction.get('removed'),'active');
  assert.equal(projectState(run,10).construction.get('removed'),'absent');
  assert.deepEqual(projectState(run,0),projectState(run,0));
});

test('camera scenes stay inside real operations and do not change their journal',()=>{
  const run:any={duration:1000,scenario:{temporary_assets:[],units:[],operations:[
    {id:'one',kind:'duct_install',name:'Install duct',target_ids:['1'],duration:50},
    {id:'two',kind:'access_setup',name:'Build access',target_ids:[],duration:100}]},operation_states:{one:{start:300,finish:350},two:{start:0,finish:100}}};
  const model:any={elements:[],storeys:[],coordinate_system:{render_origin_m:[0,0,0]}};
  const before=JSON.stringify(run),scenes=workScenes(run,model);
  for(const scene of scenes.filter(s=>s.operationId)){
    const state=run.operation_states[scene.operationId!];assert(scene.start>=state.start&&scene.end<=state.finish);
  }
  assert.deepEqual(scenes.map(s=>s.start),[...scenes.map(s=>s.start)].sort((a,b)=>a-b));
  assert.equal(JSON.stringify(run),before);
});
