import test from 'node:test';
import assert from 'node:assert/strict';
import {findWalkRoute,walkEdge,makeWorkerTask,sampleWorkerTask,taskAction,tasksConflict,reserveWorkerTask} from '../src/worker-task.ts';
import type {NavigationWorld,WorkerRoute} from '../src/worker-task.ts';
const world:NavigationWorld={minX:-5,maxX:8,minZ:-5,maxZ:8,surface:()=>0,clear:p=>!(p[0]>1&&p[0]<3&&p[2]>-1&&p[2]<1)};
const lease:any={start:10,end:30,operation:{id:'o',kind:'duct_install'}};
const route:WorkerRoute={points:[[0,0,0],[0,0,3],[0,2,3],[1,2,3]],modes:['walk','climb','walk'],basis:['test_ladder']};

test('navigation goes around solid walls and validates every simplified edge',()=>{
  const path=findWalkRoute([0,0,0],[5,0,0],world)!;assert.ok(path.length>2);
  for(let i=1;i<path.length;i++)assert.ok(walkEdge(path[i-1],path[i],world));
  assert.equal(findWalkRoute([0,0,0],[5,0,0],{...world,clear:p=>!(p[0]>1&&p[0]<3)}),null);
  assert.equal(findWalkRoute([0,0,0],[5,0,0],{...world,surface:x=>x>1&&x<3?null:0}),null);
  assert.equal(findWalkRoute([0,0,0],[0,3,0],world),null,'no invented vertical route');
});

test('worker approaches, climbs, works on its element, descends and returns continuously',()=>{
  const task=makeWorkerTask(lease,[0,0,0],[1,2,3],[1,3,3],'duct-42','Воздуховод',route);
  assert.equal(task.blocked,null);assert.equal(task.tool,'wrench');
  assert.deepEqual(sampleWorkerTask(task,10).position,task.home);
  assert.equal(sampleWorkerTask(task,10.02).phase,'approach');
  assert.equal(sampleWorkerTask(task,10.1).phase,'climb');
  assert.equal(sampleWorkerTask(task,20).phase,'work');
  assert.deepEqual(sampleWorkerTask(task,20).position,task.destination);
  assert.equal(sampleWorkerTask(task,29.99).phase,'depart');
  assert.deepEqual(sampleWorkerTask(task,30).position,task.home);
  for(const boundary of [task.approachStart,task.workStart,task.workEnd,task.end]) {
    const a=sampleWorkerTask(task,boundary-1e-6).position,b=sampleWorkerTask(task,boundary+1e-6).position;
    assert.ok(Math.hypot(...a.map((v,i)=>v-b[i]))<.001,'no teleport at phase boundary');
  }
  const at=sampleWorkerTask(task,20.12);sampleWorkerTask(task,29);sampleWorkerTask(task,10);assert.deepEqual(sampleWorkerTask(task,20.12),at);
});

test('missing access and insufficient duration do not become working states',()=>{
  const blocked=makeWorkerTask(lease,[0,0,0],[1,2,3],[1,3,3],'duct','D',route,'Нет лестницы');
  assert.equal(sampleWorkerTask(blocked,20).phase,'blocked');assert.equal(sampleWorkerTask(blocked,20).progress,0);
  const short=makeWorkerTask({...lease,end:10.1},[0,0,0],[1,2,3],[1,3,3],'duct','D',route);
  assert.ok(short.blocked);assert.equal(sampleWorkerTask(short,10.05).phase,'blocked');
});

test('crossing routes are reserved in time, not resolved by relocating a person in a frame',()=>{
  const a=makeWorkerTask({...lease,start:0,end:5},[-2,0,0],[2,0,0],[3,0,0],'a','A',{points:[[-2,0,0],[2,0,0]],modes:['walk'],basis:[]});
  const b=makeWorkerTask({...lease,start:0,end:6},[0,0,-2],[0,0,2],[0,0,3],'b','B',{points:[[0,0,-2],[0,0,2]],modes:['walk'],basis:[]});
  assert.equal(tasksConflict(a,b),true);
  const reserved=reserveWorkerTask(b,[a]);assert.ok(reserved);assert.equal(tasksConflict(a,reserved),false);
  assert.equal(sampleWorkerTask(reserved,.01).phase,'waiting');
  const same=makeWorkerTask({...lease,start:0,end:5},[-2,0,1],[2,0,0],[3,0,0],'c','C',{points:[[-2,0,1],[2,0,0]],modes:['walk'],basis:[]});
  assert.equal(reserveWorkerTask(same,[a]),null,'overlapping work positions need another location');
});

test('tools correspond to the actual operation, not just the crew resource',()=>{
  assert.equal(taskAction('reinforcement').tool,'pliers');assert.equal(taskAction('concreting').tool,'hose');
  assert.equal(taskAction('masonry').tool,'trowel');assert.equal(taskAction('inspection').tool,'meter');
  assert.equal(taskAction('formwork').tool,'hammer');assert.equal(taskAction('duct_install').tool,'wrench');
});
