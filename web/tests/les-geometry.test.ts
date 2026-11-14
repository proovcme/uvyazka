import {afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {cadEntityTarget,cadOriginal,sceneForSource} from '../src/les-geometry.ts';
import {createHash} from 'node:crypto';
const originalFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=originalFetch;});
const target={project:'example',dataset:'snapshot',object:'object-1',sha256:'a'.repeat(64)};
test('CAD focus uses a unique native hexadecimal handle, not a label or a block fallback',()=>{
  assert.equal(cadEntityTarget([{id:'2F'}],{section:'elements',identifiers:{handle:'002f'}}),'2F');
  assert.throws(()=>cadEntityTarget([{id:'other'}],{section:'elements',native_id:'2F'}));
  assert.throws(()=>cadEntityTarget([{id:'2F'},{id:'02f'}],{section:'elements',native_id:'2F'}));
  assert.throws(()=>cadEntityTarget([{id:'2F'}],{section:'blocks',native_id:'2F'}));
});
test('scene lookup follows all pages and refuses filename matching or ambiguous exports',async()=>{
  const calls:string[]=[];
  globalThis.fetch=async(url)=>{calls.push(String(url));return new Response(JSON.stringify({project_id:'example',items:calls.length===1?[{model_id:'1'.repeat(64),name:'Same.rvt',source_sha256:'b'.repeat(64)}]:[{model_id:'2'.repeat(64),source_sha256:target.sha256}],next_offset:calls.length===1?100:null}));};
  assert.equal(await sceneForSource(target),'2'.repeat(64));assert.equal(calls.length,2);
  globalThis.fetch=async()=>new Response(JSON.stringify({project_id:'example',items:[{model_id:'1'.repeat(64),source_sha256:target.sha256},{model_id:'2'.repeat(64),source_sha256:target.sha256}],next_offset:null}));
  assert.equal(await sceneForSource(target),null);
});
test('CAD bytes are bounded and independently hashed before the drawing reader sees them',async()=>{
  const bytes=new TextEncoder().encode('synthetic CAD transfer fixture');const sha=createHash('sha256').update(bytes).digest('hex');
  globalThis.fetch=async()=>new Response(bytes,{headers:{'X-Uvyazka-Source-SHA256':sha,'Content-Length':String(bytes.length)}});
  const file=await cadOriginal({...target,sha256:sha},{format:'dxf',sha256:sha,relative_path:'Folder/Example.dxf'});
  assert.equal(file.name,'Example.dxf');assert.equal(await file.text(),'synthetic CAD transfer fixture');
  globalThis.fetch=async()=>new Response('other revision',{headers:{'X-Uvyazka-Source-SHA256':sha}});
  await assert.rejects(()=>cadOriginal({...target,sha256:sha},{format:'dxf',sha256:sha}),/Содержимое/);
  globalThis.fetch=async()=>new Response(bytes,{headers:{'X-Uvyazka-Source-SHA256':sha,'Content-Length':String(129*1024*1024)}});
  await assert.rejects(()=>cadOriginal({...target,sha256:sha},{format:'dxf',sha256:sha}),/размера/);
});
