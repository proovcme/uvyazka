import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtemp,writeFile,rm,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';

test('planner worker reuses its loaded runtime and finishes cleanup before announcing a result',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'uvyazka-planner-'));
  let worker;
  try{
    await mkdir(join(folder,'runtime/pyodide'),{recursive:true});
    await writeFile(join(folder,'runtime/pyodide/pyodide.mjs'),`
let loads=0,clean=true,runs=0;
export async function loadPyodide(){loads++;return {unpackArchive(){},globals:{set(){},delete(){}},async runPythonAsync(code){
  if(code.includes('request=json')){if(!clean)throw Error('previous cleanup incomplete');clean=false;return JSON.stringify({runs:++runs,loads});}
  await new Promise(r=>setTimeout(r,20));clean=true;
}};}`);
    const script=new URL('../src/planner.worker.ts',import.meta.url).href;
    worker=new Worker(`const {parentPort}=require('node:worker_threads');
global.self={postMessage:value=>parentPort.postMessage(value)};
global.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)});
parentPort.on('message',data=>self.onmessage({data}));
import(${JSON.stringify(script)}).then(()=>parentPort.postMessage({kind:'ready'}));`,{eval:true});
    const next=(kind)=>new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{worker.off('message',receive);reject(Error('Worker response timed out: '+kind));},10000);
      const receive=value=>{if(value.kind==='error'||value.kind===kind){clearTimeout(timeout);worker.off('message',receive);value.kind==='error'?reject(Error(value.message)):resolve(value);}};
      worker.on('message',receive);worker.once('error',reject);
    });
    await next('ready');
    const base=pathToFileURL(folder+'/').href;
    let planned=next('planned');worker.postMessage({job:1,base,model:{}});
    assert.deepEqual((await planned).run,{runs:1,loads:1});
    // A second request arrives immediately after planned. The runtime must be idle.
    planned=next('planned');worker.postMessage({job:2,base,model:{}});
    assert.deepEqual((await planned).run,{runs:2,loads:1});
    const pong=next('pong');worker.postMessage({kind:'ping',job:2});assert.equal((await pong).job,2);
  }finally{await worker?.terminate();const actual=await realpath(folder);assert.equal(dirname(actual),await realpath(tmpdir()));assert(basename(actual).startsWith('uvyazka-planner-'));await rm(actual,{recursive:true,force:true});}
});
