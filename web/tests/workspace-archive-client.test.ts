import test from 'node:test';import assert from 'node:assert/strict';
import {archiveTask} from '../src/workspace-archive-client.ts';
class WorkerFixture {
 static instances:WorkerFixture[]=[];terminated=0;sent:any;onmessage:any;onerror:any;onmessageerror:any;
 constructor(..._args:any[]){WorkerFixture.instances.push(this);}
 postMessage(data:any){this.sent=data;}terminate(){this.terminated++;}
}
test('archive cancellation terminates its worker, rejects once, and never applies a late scene',async()=>{
 const original=globalThis.Worker;globalThis.Worker=WorkerFixture as any;WorkerFixture.instances=[];
 try{const run=new AbortController(),progress:string[]=[];let applied=false;
  const task=archiveTask('unpack',new ArrayBuffer(0),{signal:run.signal,progress:s=>progress.push(s)}).then(()=>{applied=true;});
  const worker=WorkerFixture.instances[0];worker.onmessage({data:{progress:'Проверка состава…'}});assert.deepEqual(progress,['Проверка состава…']);assert.equal(worker.terminated,0);
  run.abort();await assert.rejects(task,{name:'AbortError'});assert.equal(worker.terminated,1);
  worker.onmessage({data:{scene:{model:'late'}}});assert.equal(applied,false);assert.equal(worker.terminated,1);
  await assert.rejects(archiveTask('unpack',new ArrayBuffer(0),{signal:run.signal}),{name:'AbortError'});assert.equal(WorkerFixture.instances.length,1);
 }finally{globalThis.Worker=original;}
});
test('archive progress is separate from completion and worker errors always free resources',async()=>{
 const original=globalThis.Worker;globalThis.Worker=WorkerFixture as any;WorkerFixture.instances=[];
 try{const task=archiveTask('unpack',new ArrayBuffer(0),{progress:()=>{throw Error('observer');}}),worker=WorkerFixture.instances[0];
  worker.onmessage({data:{progress:'Свойства…'}});assert.equal(worker.terminated,0);worker.onmessage({data:{scene:{name:'synthetic'}}});assert.deepEqual(await task,{name:'synthetic'});assert.equal(worker.terminated,1);
  const failed=archiveTask('unpack',new ArrayBuffer(0)),second=WorkerFixture.instances[1];second.onmessageerror();await assert.rejects(failed,/результат/);assert.equal(second.terminated,1);
 }finally{globalThis.Worker=original;}
});
