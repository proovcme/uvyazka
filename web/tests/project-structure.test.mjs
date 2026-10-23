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
