import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';

const code=await readFile(new URL('../../src/uvyazka/ui/structure.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,10));
const counts={indexed_documents:1,partial_documents:0,pending_documents:0,failed_documents:0,unsupported_documents:0,unhashed_documents:0,indexed_units:1,total_known_units:1,tables:1,stored_rows:2};
const source={doc_id:'doc',sha256:'a'.repeat(64),relative_path:'АР.xlsx'};
const card={table_id:'table',name:'Оборудование',unit_name:'Лист 1',unit_kind:'excel_sheet',source,row_count:2,column_count:2,profile_candidate:{types:[]}};
const cell=(row,column,value)=>({cell_id:`table:${row}:${column}`,row,column,text:value,state:'value',locator:{kind:'excel_cell',sheet:'Лист 1',cell:`${column===1?'A':'B'}${row}`},readings:{}});

test('source grids expose copyable literal cells and append human reading to shared API',async()=>{
 const w=new Window({url:'http://127.0.0.1:8773/?project=a#structure'});w.document.body.innerHTML='<div id="view"></div>';
 const rows=[[cell(1,1,'Насос <script>'),cell(1,2,'0')],[cell(2,1,'Насос 2'),cell(2,2,'3')]];
 const requests=[];w.fetch=async(path,options={})=>{
  const u=new URL(path,w.location.origin);requests.push({url:u,options});let data;
  if(u.pathname.endsWith('/catalog'))data={items:[{name:'Лист 1',source,table_ids:['table'],warnings:[],physical_page:false}],coverage:counts,next_offset:null};
  else if(u.pathname.endsWith('/config'))data={write_token:'secret'};
  else if(u.pathname.endsWith('/table'))data={table:card,rows,current_registered_version:true,next_offset:null,next_column_offset:null};
  else if(u.pathname.endsWith('/review')){const body=JSON.parse(options.body);assert.equal(body.method,'cached_extraction');assert.equal(body.reader,'human');assert.equal(body.expected_revision,0);rows[0][1].readings.human={...body,revision:1,comparison:'matches_literal'};data=rows[0][1].readings.human;}
  else throw Error('Unexpected request '+path);
  return {ok:true,json:async()=>structuredClone(data)};
 };
 w.eval(code);await w.UvyazkaStructure.mount(w.document.querySelector('#view'),'a');
 assert.match(w.document.body.textContent,/Файлы: 1 прочитано/);
 w.document.querySelector('[data-table]').click();await tick();
 assert.equal(w.document.querySelectorAll('[data-cell-id]').length,4);
 assert.equal(w.document.querySelector('script'),null);
 w.document.querySelector('[data-cell-id="table:1:2"]').click();
 assert.equal(w.document.querySelector('textarea[readonly]').value,'0');
 const form=w.document.querySelector('[data-review]');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(w.document.querySelector('[data-review-status]').textContent,'Сохранено');
 const saved=requests.find(r=>r.url.pathname.endsWith('/review'));
 assert.equal(saved.options.headers['X-Uvyazka-Token'],'secret');
 assert.ok(requests.every(r=>r.url.searchParams.get('project_id')==='a'));
 assert.match(w.document.querySelector('[data-cell]').textContent,/Совпадает буквально/);
 w.happyDOM.cancelAsync();
});

test('unmounting while a batch runs stops further project mutations',async()=>{
 const w=new Window({url:'http://127.0.0.1:8773/'});w.document.body.innerHTML='<div id="view"></div>';
 let complete,posts=0;
 w.fetch=async(path,options={})=>{
  if(options.method==='POST'){posts++;return await new Promise(resolve=>{complete=()=>resolve({ok:true,json:async()=>({coverage:{...counts,pending_documents:1},processed:[{}]})});});}
  return {ok:true,json:async()=>path.includes('/config')?{write_token:'secret'}:{items:[],coverage:counts,next_offset:null}};
 };
 w.eval(code);const host=w.document.querySelector('#view');await w.UvyazkaStructure.mount(host,'a');host.querySelector('[data-build]').click();await tick();
 assert.equal(posts,1);host.innerHTML='Другой проект';complete();await tick();assert.equal(posts,1);assert.equal(host.textContent,'Другой проект');w.happyDOM.cancelAsync();
});

test('person can continue a model interpretation without replacing its lane',async()=>{
 const w=new Window({url:'http://127.0.0.1:8773/?project=a&structure_analysis=meaning#structure'});w.document.body.innerHTML='<div id="view"></div>';
 const model={analysis_id:'meaning',table_id:'table',reader:'model',title:'Шапка и связи',summary:'Сложить два способа крепления.',revision:1,data:{operation:'sum',checks:[{status:'match',title:'Количество совпало',detail:'991 + 170 = 1161'},{status:'unchecked',title:'Питание не проверено'}]},related_tables:[],related_sources:[{doc_id:'scan',sha256:'abc',page_number:3,reason:'Скан'}],dependencies:[{source_id:'scan-ref',source:{doc_id:'scan',sha256:'abc',page_number:3,extension:'.pdf',relative_path:'scan.pdf'}}],evidence_cells:['table:1:2'],current_sources:true};
 let saved;
 w.fetch=async(path,options={})=>{
  let data;
  if(options.method==='POST'){saved=JSON.parse(options.body);assert.equal(saved.reader,'human');assert.equal(saved.expected_revision,0);assert.equal(saved.analysis_id,'meaning');assert.equal(saved.data.operation,'sum');assert.equal(saved.related_sources[0].doc_id,'scan');data={...saved,revision:1};}
  else if(path.includes('/config'))data={write_token:'secret'};
  else if(path.includes('/analysis?'))data={items:[model,...(saved?[{...saved,revision:1,current_sources:true}]:[])],next_offset:null};
  else if(path.includes('/table'))data={table:card,rows:[[cell(1,1,'Лоток'),cell(1,2,'991')]],current_registered_version:true,next_offset:null,next_column_offset:null,analyses:{items:[model,...(saved?[{...saved,revision:1,current_sources:true}]:[])],next_offset:null}};
  else data={items:[{name:'Лист',source,table_ids:['table'],warnings:[],physical_page:false}],coverage:counts,next_offset:null};
  return {ok:true,json:async()=>structuredClone(data)};
 };
 w.eval(code);await w.UvyazkaStructure.mount(w.document.querySelector('#view'),'a');await tick();
 assert.match(w.document.body.textContent,/Сложить два способа/);
 const filter=w.document.querySelector('[data-check-filter]');filter.value='unchecked';filter.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w.document.querySelector('[data-check-status=match]').hidden,true);assert.equal(w.document.querySelector('[data-check-status=unchecked]').hidden,false);assert.match(w.document.querySelector('a[href*=scan]').href,/#page=3$/);
 const form=w.document.querySelector('[data-analysis]');form.querySelector('[name=summary]').value='Сверено человеком';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(saved.table_id,'table');assert.equal(saved.summary,'Сверено человеком');assert.match(w.document.body.textContent,/Сверено человеком/);assert.equal(model.summary,'Сложить два способа крепления.');w.happyDOM.cancelAsync();
});


test('source-only analysis opens scans and preserves source dependencies on human handoff',async()=>{
 const w=new Window({url:'http://127.0.0.1:8773/?project=a&structure_analysis=scan-only#structure'});w.document.body.innerHTML='<div id="view"></div>';
 const model={analysis_id:'scan-only',table_id:null,reader:'model',title:'Скан и схема',summary:'Выбранные исходники.',revision:1,current_sources:false,data:{checks:[{status:'question',title:'Проверить комплектацию'}]},related_tables:[],related_sources:[{doc_id:'scan',sha256:'abc',page_number:2,reason:'Оригинал'}],dependencies:[{source_id:'s',source:{doc_id:'scan',sha256:'abc',page_number:2,extension:'.pdf',relative_path:'scan.pdf'}}],evidence_cells:[]};
 let saved;
 w.fetch=async(path,options={})=>{
  let data;
  if(options.method==='POST'){saved=JSON.parse(options.body);data={...saved,revision:1};}
  else if(path.includes('/config'))data={write_token:'secret'};
  else if(path.includes('/analysis?'))data={items:[model],next_offset:null};
  else data={items:[],coverage:counts,next_offset:null};
  return {ok:true,json:async()=>structuredClone(data)};
 };
 w.eval(code);await w.UvyazkaStructure.mount(w.document.querySelector('#view'),'a');await tick();
 assert.match(w.document.body.textContent,/требуют повторной проверки/);
 assert.match(w.document.querySelector('a[href*=scan]').href,/#page=2$/);
 const form=w.document.querySelector('[data-analysis]');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(saved.table_id,null);assert.equal(saved.reader,'human');assert.equal(saved.related_sources[0].doc_id,'scan');w.happyDOM.cancelAsync();
});
