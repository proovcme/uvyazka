import test from 'node:test';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {Window} from 'happy-dom';
const bundle=await build({entryPoints:['src/review-panel.ts'],bundle:true,format:'esm',write:false,loader:{'.css':'empty'},logLevel:'silent'});
const {reviewPanel}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('review form preserves native category selection, uses literal names and versioned shared writes',async t=>{
 const w=new Window();t.after(()=>w.happyDOM.close());
 for(const name of ['document','Option','CSS','HTMLElement','HTMLInputElement'])globalThis[name]=w[name];
 globalThis.Option=function(text,value){const option=document.createElement('option');option.textContent=text;option.value=value;return option;};
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let saved;
 globalThis.fetch=async(url,options={})=>({ok:true,json:async()=>{
  if(String(url).includes('/config'))return {token:'synthetic-token'};
  if(options.method==='POST'){saved=JSON.parse(options.body);return {revision:1};}
  return {items:[],next_offset:null};
 }});
 document.body.innerHTML='<button id="open-network">Связи</button>';
 const model={model_id:'a'.repeat(64),source:{format:'ifc',sha256:'b'.repeat(64)},elements:[{id:'1',role:'element',class:'IfcWall',hierarchy:['IfcWall'],name:'<img src=x onerror=alert(1)>',storey_id:'L1'},{id:'2',role:'element',class:'IfcDuctSegment',hierarchy:['IfcDuctSegment'],name:'Учебный воздуховод',storey_id:'L1'}],storeys:[{id:'L1',name:'Уровень 1'}],systems:[]};
 reviewPanel({shared:true,project:()=> 'demo-a',capture:()=>({model,binary:new ArrayBuffer(4),state:{}}),selection:()=>[],matches:()=>[],focus:()=>{},apply:()=>{},projection:()=>({aspect:1,vertical_fov:40}),snapshot:()=>''});
 const settle=()=>new Promise(r=>setTimeout(r,10));document.querySelector('#open-review').click();await settle();
 const category=document.querySelector('select[aria-label="Категории A"]');category.value='["ifc","IfcWall"]';category.dispatchEvent(new w.Event('change'));await settle();
 assert.equal(document.querySelector('select[aria-label="Категории A"]').value,'["ifc","IfcWall"]');
 const input=document.querySelector('input[aria-label="Название проверки"]');input.value='Стенд <img src=x>';input.dispatchEvent(new w.Event('input'));
 [...document.querySelectorAll('button')].find(b=>b.textContent==='Сохранить шаблон').click();await settle();
 assert.equal(saved.kind,'clash_template');assert.equal(saved.expected_revision,0);assert.equal(saved.payload.name,'Стенд <img src=x>');assert.deepEqual(saved.payload.left.categories,['["ifc","IfcWall"]']);assert.equal(document.querySelectorAll('img').length,0);
});
