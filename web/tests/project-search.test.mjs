import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
const code=await readFile(new URL('../../src/uvyazka/ui/language.js',import.meta.url),'utf8')+'\n'+await readFile(new URL('../../src/uvyazka/ui/search.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,10));
const status={configured:true,counts:{ready:2,pending:0,failed:0},cached_blocks:3};
const json=data=>({ok:true,json:async()=>structuredClone(data)});
function setup(fetch){const w=new Window({url:'http://127.0.0.1:8777/?project=a#search'});w.document.body.innerHTML='<div id="view"></div>';w.fetch=fetch;w.eval(code);return w;}

test('search submits once, scopes project and preserves copyable source/version locators',async()=>{
 let searches=0,params;
 const w=setup(async path=>{if(path.includes('/search?')){searches++;params=new URL(path,w.location.origin).searchParams;return json({status,effective_mode:'literal',fallback_reason:'identifier_lookup_uses_exact_terms',results:[{relative_path:'<ЩН>.pdf',doc_id:'d',sha256:'a'.repeat(64),parser_revision:'r',page_number:4,locator:{kind:'pdf_page',pdf_page:4},snippet:'Н-1 <кабель>',retrieval_kind:'literal'}]});}return json(status);});
 await w.UvyazkaSearch.mount(w.document.querySelector('#view'),'a');
 const input=w.document.querySelector('[data-query]');input.value='Н-1';input.dispatchEvent(new w.Event('input'));await tick();assert.equal(searches,0);
 w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(searches,1);assert.equal(params.get('project_id'),'a');assert.equal(params.get('q'),'Н-1');
 assert.equal(w.document.querySelector('.memory-hit h2').textContent,'<ЩН>.pdf');assert.match(w.document.body.textContent,/ищем точно/);
 assert.deepEqual(JSON.parse(w.document.querySelector('[data-source]').dataset.source),{doc_id:'d',sha256:'a'.repeat(64),parser_revision:'r',page_number:4});
 assert.match(w.document.body.textContent,/Н-1 <кабель>/);w.happyDOM.cancelAsync();
});

test('preparation uses protected resumable batches and stops after the active batch',async()=>{
 let complete,posts=0;
 const w=setup(async(path,options={})=>{
  if(path.includes('/config'))return json({write_token:'secret'});
  if(options.method==='POST'){posts++;assert.equal(options.headers['X-Uvyazka-Token'],'secret');assert.deepEqual(JSON.parse(options.body),{limit:12});return await new Promise(r=>{complete=()=>r(json({processed:[{state:'ready'}],status:{...status,counts:{ready:1,pending:9,failed:0}}}));});}
  return json(status);
 });
 await w.UvyazkaSearch.mount(w.document.querySelector('#view'),'a');w.document.querySelector('[data-build]').click();await tick();
 assert.match(w.document.body.textContent,/первая подготовка поиска/);w.document.querySelector('[data-stop]').click();complete();await tick();
 assert.equal(posts,1);assert.match(w.document.querySelector('[data-progress]').textContent,/Приостановлено.*Обработано 1/);w.happyDOM.cancelAsync();
});

test('no write after leaving project while fetching the local token',async()=>{
 let resume,posts=0;
 const w=setup(async(path,options={})=>{if(options.method==='POST')posts++;if(path.includes('/config'))return await new Promise(r=>{resume=()=>r(json({write_token:'secret'}));});return json(status);});
 const host=w.document.querySelector('#view');await w.UvyazkaSearch.mount(host,'a');host.querySelector('[data-build]').click();await tick();host.innerHTML='other project';resume();await tick();assert.equal(posts,0);w.happyDOM.cancelAsync();
});

test('unconfigured mode explains exact fallback and empty coverage without claiming absence',async()=>{
 const missing={...status,configured:false,counts:{ready:0,pending:0,failed:0}};
 const w=setup(async path=>json(path.includes('/search?')?{status:missing,effective_mode:'literal',fallback_reason:'worker_not_configured',results:[]}:missing));
 await w.UvyazkaSearch.mount(w.document.querySelector('#view'),'a');assert.equal(w.document.querySelector('[data-build]').disabled,true);
 w.document.querySelector('[data-query]').value='Лифты';w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.match(w.document.body.textContent,/не доказывает отсутствия/);assert.match(w.document.body.textContent,/не настроен/);w.happyDOM.cancelAsync();
});
