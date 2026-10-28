import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import {fileURLToPath} from 'node:url';

test('appending RVT in public viewer keeps its catalogue through project and federation changes',async t=>{
 const win=new Window({url:'https://example.test/uvyazka/'});t.after(()=>{win.dispatchEvent(new win.Event('pagehide'));win.happyDOM.close();});
 for(const name of ['document','location','history','Option','CustomEvent','Event','localStorage'])Object.defineProperty(globalThis,name,{value:win[name],writable:true,configurable:true});
 globalThis.window=win;globalThis.addEventListener=win.addEventListener.bind(win);globalThis.matchMedia=win.matchMedia.bind(win);globalThis.requestAnimationFrame=win.requestAnimationFrame.bind(win);globalThis.cancelAnimationFrame=win.cancelAnimationFrame.bind(win);
 globalThis.Option=function(text,value){const o=document.createElement('option');o.textContent=text;o.value=value;return o;};document.body.innerHTML='<div id="app"></div>';
 const make=(hash,name,format='ifc')=>({model_id:hash,contract:'ModelPackage',contract_version:'0.1.0',source:{sha256:hash,filename:name,format,schema:'IFC4'},statistics:{physical_elements:1,meshes:1,binary_bytes:4},storeys:[],systems:[],elements:[{id:'1',step_id:1,name:'Насос',role:'element',storey_id:null,class:'IfcPump',materials:[],property_sets:{},quantity_sets:{},mesh:null}]});
 const initial=make('0'.repeat(64),'clinic.ifc');
 globalThis.fetch=async input=>{const path=new URL(String(input),location.href).pathname;let body;
  if(path.endsWith('/projects.json'))body={projects:[{id:'demo-a',name:'Demo'}],default_project:'demo-a'};
  else if(path.endsWith('/models.json'))body={items:[{model_id:initial.model_id,name:'Clinic'}]};
  else if(path.endsWith('/runs.json')||path.endsWith('/examples.json'))body={items:[]};
  else if(path.includes('/model-'))body=initial;
  else if(path.includes('/geometry-'))return new Response(new ArrayBuffer(4));
  else throw Error('Unexpected URL '+path);
  return new Response(JSON.stringify(body));};
 const result=await build({entryPoints:[fileURLToPath(new URL('../src/main.ts',import.meta.url))],bundle:true,write:false,format:'esm',loader:{'.css':'empty'},define:{'import.meta.env.VITE_UVYAZKA_DEMO':'"1"'},plugins:[{name:'presentation-stubs',setup(build){
  build.onResolve({filter:/^\.\/(viewer|spatial-panel|browser-panel|federation|federation-client)$/},args=>({path:args.path,namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='./viewer'?`export class Viewer {constructor(){globalThis.__viewer=this;return new Proxy(this,{get:(o,k)=>k in o?o[k]:()=>{}})} captureView(){return {position:[1,2,3],target:[0,0,0],up:[0,1,0],planes:[],xray:false}}load(pkg){if(pkg.source.filename==='render-failure.rvt')throw Error('synthetic renderer failure');this.loaded=true;}}`:args.path==='./spatial-panel'?'export const spatialPanel=()=>({reset(){}});':args.path==='./browser-panel'?'export const browserPanel=cb=>{globalThis.__callbacks=cb;return {}};':`export const federationBudget=()=>{};export const federate=async members=>{if(members.some(member=>member.model.source.filename==='prepare-failure.rvt'))throw Error('synthetic preparation failure');return ({binary:new ArrayBuffer(4),model:{...members[0].model,model_id:'federated',source:{...members[0].model.source,sha256:'f'.repeat(64),filename:members.some(member=>member.model.source.filename==='render-failure.rvt')?'render-failure.rvt':'Federated',format:'federation'},federation:{members:members.map(m=>({instance_id:m.instanceId,model_id:m.model.model_id,label:m.model.source.filename,source_sha256:m.model.source.sha256,source_format:m.model.source.format})),note:''},elements:members.flatMap(m=>m.model.elements.map(e=>({...e,id:m.instanceId+':'+e.id,source_instance_id:m.instanceId})))}});};export const prepareScene=federate;`}));
 }}]});
 await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
 const wait=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<100&&!globalThis.__viewer.loaded;i++)await wait(10);assert.equal(globalThis.__viewer.loaded,true);
 const callbacks=globalThis.__callbacks,hash='a'.repeat(64),pkg=make(hash,'new.rvt','rvt');
 callbacks.reset(true);
 await callbacks.model(pkg,new ArrayBuffer(4),true);
 callbacks.document({schema_version:1,schema_sha256:'b'.repeat(64),status:'partial',clipped_records:0,summary:{},source:{sha256:hash,filename:'new.rvt',size_bytes:42},evaluated_schedule_body_available:false,records:[{identity:{element_id:'9007199254740993'},kind:'view',class_name:'DBViewDrafting',status:'partial',source:{stream:'Partitions/1'},graph:{objects:[{class_name:'DBViewDrafting',fields:{m_viewName:'Лист А',m_sheetNumber:'АР-1'}}],edges:[]}}]});
 const oldTitle=document.getElementById('file-title').textContent;await assert.rejects(()=>callbacks.model(make('c'.repeat(64),'prepare-failure.rvt','rvt'),new ArrayBuffer(4),true),/synthetic preparation failure/);assert.equal(document.getElementById('file-title').textContent,oldTitle);await assert.rejects(()=>callbacks.model(make('d'.repeat(64),'render-failure.rvt','rvt'),new ArrayBuffer(4),true),/synthetic renderer failure/);assert.equal(document.getElementById('file-title').textContent,oldTitle);
 const search=document.getElementById('element-search');search.value='Лист';search.dispatchEvent(new win.Event('input'));await wait(220);
 assert.equal(document.querySelectorAll('.document-item').length,1);assert.equal(document.querySelector('.document-only'),null);
 const root=document.querySelector('.document-item').closest('.branch-model');assert.match(root.querySelector(':scope>summary').textContent,/new.rvt/);
 document.querySelector('.document-item').click();assert.match(document.getElementById('rvt-record-detail').textContent,/9007199254740993/);assert.match(document.getElementById('rvt-catalog-storage').textContent,/этом браузере/);
});
