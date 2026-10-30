import './language.js';
import {pagePoint, imagePoint, parsePoints} from '/measurement-coordinates.js';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusText = {calculated_unreviewed:'Контур требует проверки',agent_checked:'Отметка агента: геометрия проверена',question:'Есть вопрос'};
const staleText = {source_changed_or_unavailable:'Источник изменился или недоступен',view_revision_changed:'Изменился вид',calibration_changed:'Изменился контрольный размер',measurement_superseded:'Есть новая ревизия',calibration_superseded:'Есть новая калибровка'};
const pendingKey = 'uvyazka-measurement-request';
let project='', token='', doc=null, view=null, calibration=null, metadata=null, points=[], mode='inspect', editing=null;
let documents=[], views=[], records=[], docOffset=0, viewOffset=0, recordOffset=0, docNext=null, viewNext=null, recordNext=null;
let pending=null, busy=false, historyId='', historyOffset=0;
try { pending=JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch { /* Storage unavailable: in-memory retry still works. */ }

function endpoint(key, params={}) {
  const u=new URL('/api/measurements/'+key, location.origin);
  for(const [k,v] of Object.entries({project_id:project,...params})) if(v!==null && v!==undefined)u.searchParams.set(k,String(v));
  return u.pathname+u.search;
}
async function read(key, params={}) { const r=await fetch(endpoint(key,params));const d=await r.json();if(!r.ok)throw Error(d.error||'Ошибка чтения проекта');return d; }
function message(text,error=false){if(error)UvyazkaLanguage.showError($('message'),text);else $('message').textContent=text;$('message').dataset.error=String(error);}
function controls(){
  document.querySelectorAll('button,input,select,textarea').forEach(e=>e.disabled=busy || !!pending);
  $('retry').hidden=!pending;$('retry').disabled=busy;
  $('close-history').disabled=false;
  $('save').disabled=busy||!!pending||!metadata||mode==='inspect';
  $('prev-docs').disabled=busy||!!pending||docOffset===0;$('next-docs').disabled=busy||!!pending||docNext===null;
  $('prev-views').disabled=busy||!!pending||viewOffset===0;$('next-views').disabled=busy||!!pending||viewNext===null;
  $('prev-records').disabled=busy||!!pending||recordOffset===0;$('next-records').disabled=busy||!!pending||recordNext===null;
  document.querySelectorAll('[data-mode]').forEach(b=>{if(['calibration','length','area'].includes(b.dataset.mode))b.disabled ||= !view || !!view.stale_reasons.length;});
  $('new-view').disabled ||= !metadata;
  $('control-field').hidden=mode!=='calibration';
}
async function run(fn){
  if(busy)return;busy=true;controls();
  try{await fn();}catch(e){message(e.message,true);}finally{busy=false;controls();}
}
function setMode(next){
  mode=next;points=[];editing=null;draw();
  $('editor').open=mode!=='inspect';
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  const instructions={inspect:'Выберите вид или измерение. «Обновить» получает записи, добавленные агентом.',
    view:'Укажите два противоположных угла рамки одного вида. У каждого вида своя калибровка.',
    calibration:'Укажите концы известного размера на этом виде и введите его длину в метрах.',
    length:'Отмечайте вершины ломаной по порядку. Сохраните контур, когда закончите.',
    area:'Отмечайте вершины простого контура. Последняя точка замкнётся с первой; отверстия пока не поддерживаются.'};
  $('instruction').textContent=instructions[mode];
  $('edit-title').textContent={inspect:'Основание результата',view:'Новый вид',calibration:'Контрольный размер',length:'Длина по контуру',area:'Площадь контура'}[mode];
  $('name').value='';$('basis').value='';$('reason').value='';controls();
}
function draw(){
  $('point-count').textContent='Точек: '+points.length;
  $('coordinates').value=points.map(p=>p.map(v=>Number(v.toFixed(6))).join(', ')).join('\n');
  if(!metadata){$('overlay').innerHTML='';return;}
  const coords=points.map(p=>imagePoint(p,metadata));
  let shape='';
  if(mode==='view' && coords.length===2){
    const [a,b]=coords;shape=`<rect x="${Math.min(a[0],b[0])}" y="${Math.min(a[1],b[1])}" width="${Math.abs(a[0]-b[0])}" height="${Math.abs(a[1]-b[1])}"/>`;
  }else if(coords.length>1){const tag=mode==='area'?'polygon':'polyline';shape=`<${tag} points="${coords.map(p=>p.join(',')).join(' ')}"/>`;}
  $('overlay').innerHTML=shape+coords.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r="4"/>`).join('');
}
async function listDocuments(){
  const r=await fetch('/api/documents?'+new URLSearchParams({project_id:project,q:$('query').value,offset:docOffset}));
  const data=await r.json();if(!r.ok)throw Error(data.error);
  documents=data.documents.filter(d=>d.extension==='.pdf');docNext=data.next_offset;
  $('document').innerHTML='<option value="">Выберите PDF</option>'+documents.map(d=>`<option value="${esc(d.doc_id)}">${esc(d.relative_path)}</option>`).join('');
  showDocument();$('doc-count').textContent=`${docOffset+1}–${docOffset+data.documents.length} из ${data.total} файлов`;
  if(!data.total)$('doc-count').textContent='Документы не найдены';
}
function showDocument(){
  if(doc && !Array.from($('document').options).some(o=>o.value===doc.doc_id))$('document').add(new Option(doc.relative_path||doc.doc_id,doc.doc_id));
  $('document').value=doc?.doc_id||'';
}
async function listViews(){
  const data=await read('context',{kind:'view',offset:viewOffset});views=data.items;viewNext=data.next_offset;
  $('views').innerHTML='<option value="">Весь лист</option>'+views.map(v=>`<option value="${esc(v.id)}">${esc(v.name)} · стр. ${v.page_number}${v.stale_reasons.length?' · пересмотреть':''}</option>`).join('');
  if(view&&!views.some(v=>v.id===view.id))$('views').add(new Option(view.name,view.id));
  $('views').value=view?.id||'';$('view-count').textContent=`${data.total} видов в проекте`;
}
async function loadRecords(){
  records=[];recordNext=null;
  if(view){const d=await read('context',{kind:'measurement',view_id:view.id,offset:recordOffset});records=d.items;recordNext=d.next_offset;$('record-count').textContent=d.total;
    $('record-page').textContent=d.total?`${recordOffset+1}–${recordOffset+records.length}`:'Нет записей';}
  else{$('record-count').textContent='0';$('record-page').textContent='';}
  $('records').innerHTML=records.map(r=>recordHTML(r,true)).join('');
}
function recordHTML(r, actions=false){
  return `<article class="record"><h3>${esc(r.name)}</h3><strong>${Number(r.value).toLocaleString('ru-RU',{maximumFractionDigits:4})} ${r.unit==='m2'?'м²':'м'}</strong>
  <small>Ревизия ${r.revision} · ${r.created_by==='user'?'из браузера':'от агента'} · калибровка ${r.calibration_revision}</small>
  <small>${esc(statusText[r.status]||"Требует проверки")}</small>${r.stale_reasons.length?`<p class="stale">${esc(r.stale_reasons.map(s=>staleText[s]||"Основания требуют перепроверки").join('; '))}</p>`:''}
  <small>${esc(r.basis)} · ${esc(r.reason)}</small>
  ${actions?`<div class="row"><button data-history="${esc(r.id)}">История</button><button data-edit="${esc(r.id)}">Править контур</button>${r.stale_reasons.length===1&&r.stale_reasons[0]==='calibration_changed'?`<button data-recalculate="${esc(r.id)}">Пересчитать</button>`:''}</div>`:''}
  <details><summary>Источник и координаты</summary><pre>${esc(JSON.stringify({id:r.id,status:r.status,stale_reasons:r.stale_reasons,source:r.source,view_id:r.view_id,view_revision:r.view_revision,points:r.points,review:r.review},null,2))}</pre></details></article>`;
}
async function render(){
  metadata=null;$('paper').hidden=true;$('blank').hidden=false;
  const u=new URL(location.href);if(view)u.searchParams.set('view',view.id);else u.searchParams.delete('view');history.replaceState(null,'',u);
  if(!doc)return;
  const ids=records.filter(r=>r.view_revision===view?.revision).map(r=>r.id);
  const result=await read('render',{doc_id:doc.doc_id,sha256:doc.sha256,page:Number($('page').value),view_id:view?.id,measurement_ids:ids.join(',')});
  $('sheet').src=result.image;await $('sheet').decode();metadata=result.metadata;
  $('overlay').setAttribute('viewBox',`0 0 ${metadata.pixel_size.join(' ')}`);
  $('paper').hidden=false;$('blank').hidden=true;draw();
  $('frame-info').textContent=`Стр. ${metadata.page_number} · ${view?view.name:'Весь лист'} · экран ${$('zoom').selectedOptions[0].text}`;
  $('source-info').innerHTML=`<strong>${esc(doc.relative_path||doc.doc_id)}</strong><p>SHA-256 ${esc(doc.sha256)}</p>${view?`Вид ${esc(view.id)} · ревизия ${view.revision}`:''}`;
}
async function refresh(){
  if(view){const d=await read('context',{record_id:view.id});view=d.items[0]||null;}
  calibration=view?(await read('context',{kind:'calibration',view_id:view.id})).items[0]||null:null;
  $('calibration-info').textContent=calibration?`Контроль: ${calibration.length_m} м · ревизия ${calibration.revision}. ${calibration.stale_reasons.length?'Требуется новая калибровка.':'Равномерный масштаб в пределах вида.'}`:'Масштаб вида ещё не задан.';
  await listViews();await loadRecords();await render();
}
async function openProject(id){
  project=id;doc=view=calibration=metadata=null;docOffset=viewOffset=recordOffset=0;points=[];
  const u=new URL(location.href);u.searchParams.set('project',id);u.searchParams.delete('view');history.replaceState(null,'',u);
  $('project').value=id;$('back').href='/?project='+encodeURIComponent(id)+'#measurements';$('model-link').href='/simulation/?project='+encodeURIComponent(id);
  token=(await read('runtime')).write_token;
  await listDocuments();await listViews();await loadRecords();setMode('inspect');await render();
  if(pending)message('Остался запрос без подтверждения. Повторите его: ключ запроса защищает от дублей.',true);
}
async function chooseView(id){
  view=views.find(v=>v.id===id)||(id?(await read('context',{record_id:id})).items[0]:null)||null;recordOffset=0;setMode('inspect');
  if(view){doc=documents.find(d=>d.doc_id===view.doc_id&&d.sha256===view.sha256)||{doc_id:view.doc_id,sha256:view.sha256};$('page').value=view.page_number;showDocument();}
  await refresh();
}
function storePending(){try{if(pending)sessionStorage.setItem(pendingKey,JSON.stringify(pending));else sessionStorage.removeItem(pendingKey);}catch{/* Retry remains available until this tab closes. */}}
async function write(action,args){
  pending={project,action,args:{...args,request_id:crypto.randomUUID()}};
  storePending();return sendPending();
}
async function sendPending(){
  if(!pending||pending.project!==project)throw Error('Запрос относится к другому проекту.');
  const r=await fetch(endpoint(pending.action),{method:'POST',headers:{'Content-Type':'application/json','X-Uvyazka-Token':token},body:JSON.stringify(pending.args)});
  const d=await r.json();
  // Definite validation refusal can be corrected. An ambiguous network/5xx result retains its key.
  if(!r.ok){if(r.status>=400&&r.status<500){pending=null;storePending();}throw Error(d.error||'Запрос не подтверждён. Повторите его.');}
  pending=null;storePending();
  if(d.view)view={...d.view,stale_reasons:[]};
  setMode('inspect');await refresh();message('Сохранено в базе проекта. Запись доступна агенту через MCP.');
}
async function save(){
  if(!metadata)throw Error('Сначала откройте лист.');
  const name=$('name').value.trim(),basis=$('basis').value.trim(),reason=$('reason').value.trim();
  if(!basis||!reason)throw Error('Укажите основание и комментарий к записи.');
  if(mode==='view'){
    if(points.length!==2||!name)throw Error('Нужны название и два угла рамки.');
    const [a,b]=points;
    return write('view',{view:{id:'view-'+crypto.randomUUID(),name,kind:'user_defined',doc_id:doc.doc_id,sha256:doc.sha256,page_number:metadata.page_number,region:[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])],measurement_basis:basis,reason},expected_revision:0});
  }
  if(!view)throw Error('Выберите отдельный вид.');
  if(mode==='calibration')return write('calibration',{view_id:view.id,expected_view_revision:view.revision,expected_calibration_revision:calibration?.revision||0,points,length_m:Number($('length').value),basis:basis+' — '+reason});
  if(!calibration||calibration.stale_reasons.length)throw Error('Сначала задайте актуальный контрольный размер.');
  if(!name)throw Error('Укажите название измерения.');
  return write('measure',{view_id:view.id,view_revision:view.revision,calibration_revision:calibration.revision,items:[{id:editing?.id||'measure-'+crypto.randomUUID(),expected_revision:editing?.revision||0,kind:mode,name,basis,reason,points}]});
}
async function loadHistory(append=false){
  const data=await read('context',{kind:'measurement',record_id:historyId,history:'1',offset:historyOffset});
  if(!append)$('history-body').innerHTML='';
  $('history-body').insertAdjacentHTML('beforeend',data.items.map(r=>recordHTML(r)).join(''));
  historyOffset=data.next_offset;$('more-history').hidden=historyOffset===null;
  if(!$('history').open)$('history').showModal();
}

$('project').onchange=()=>run(()=>openProject($('project').value));
$('find-docs').onsubmit=e=>{e.preventDefault();run(async()=>{docOffset=0;await listDocuments();});};
$('document').onchange=()=>run(async()=>{doc=documents.find(d=>d.doc_id===$('document').value)||doc;view=null;recordOffset=0;$('page').value=1;setMode('inspect');await refresh();});
$('open-page').onsubmit=e=>{e.preventDefault();run(async()=>{view=null;recordOffset=0;setMode('inspect');await refresh();});};
$('views').onchange=()=>run(()=>chooseView($('views').value));
$('reload').onclick=()=>run(async()=>{setMode('inspect');await refresh();message('Записи обновлены.');});
$('new-view').onclick=()=>run(async()=>{view=null;recordOffset=0;await refresh();setMode('view');});
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
$('zoom').onchange=()=>{$('paper').style.width=Number($('zoom').value)*100+'%';if(metadata)$('frame-info').textContent=`Стр. ${metadata.page_number} · экран ${$('zoom').selectedOptions[0].text}`;};
$('overlay').onclick=e=>{
  if(busy||pending||!metadata||mode==='inspect')return;
  if(['view','calibration'].includes(mode)&&points.length===2){message('Уже две точки. Уберите последнюю или очистите контур.',true);return;}
  if(points.length>=500){message('Достигнут предел 500 точек.',true);return;}
  points.push(pagePoint(e.clientX,e.clientY,$('overlay').getBoundingClientRect(),metadata));draw();
};
$('undo').onclick=()=>{points.pop();draw();};$('clear').onclick=()=>{points=[];draw();};
$('apply-coordinates').onclick=()=>{try{points=parsePoints($('coordinates').value);draw();}catch(e){message(e.message,true);}};
$('save-form').onsubmit=e=>{e.preventDefault();run(save);};$('retry').onclick=()=>run(sendPending);
$('prev-docs').onclick=()=>run(async()=>{docOffset=Math.max(0,docOffset-30);await listDocuments();});
$('next-docs').onclick=()=>run(async()=>{docOffset=docNext;await listDocuments();});
$('prev-views').onclick=()=>run(async()=>{viewOffset=Math.max(0,viewOffset-40);await listViews();});
$('next-views').onclick=()=>run(async()=>{viewOffset=viewNext;await listViews();});
$('prev-records').onclick=()=>run(async()=>{recordOffset=Math.max(0,recordOffset-40);await loadRecords();await render();});
$('next-records').onclick=()=>run(async()=>{recordOffset=recordNext;await loadRecords();await render();});
$('records').onclick=e=>{
  const b=e.target.closest('button');if(!b)return;
  run(async()=>{
    if(b.dataset.history){historyId=b.dataset.history;historyOffset=0;await loadHistory();return;}
    const r=records.find(r=>r.id===(b.dataset.edit||b.dataset.recalculate));if(!r)return;
    if(b.dataset.recalculate){
      const reason=$('reason').value.trim();if(!reason){$('editor').open=true;throw Error('Укажите причину пересчёта в поле «Комментарий к записи», затем нажмите «Пересчитать» снова.');}
      return write('recalculate',{view_id:view.id,view_revision:view.revision,calibration_revision:calibration.revision,items:[{id:r.id,expected_revision:r.revision}],reason});
    }
    if(r.stale_reasons.some(s=>s!=='calibration_changed'))throw Error('Изменился источник или вид. Перепроверьте его через агента перед исправлением.');
    setMode(r.kind);editing=r;points=r.points.map(p=>[...p]);$('name').value=r.name;$('basis').value=r.basis;draw();
    message('Редактирование ревизии '+r.revision+'. Укажите причину изменения.');
  });
};
$('close-history').onclick=()=>$('history').close();
$('more-history').onclick=()=>run(()=>loadHistory(true));
run(async()=>{
  const r=await fetch('/api/projects');const d=await r.json();if(!r.ok)throw Error(d.error);
  $('project').innerHTML=d.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const params=new URL(location.href).searchParams;
  const id=pending?.project||params.get('project')||d.default_project, requestedView=params.get('view');
  if(!id)throw Error('Нет проектов. Зарегистрируйте папку и выполните scan_project через MCP.');
  await openProject(id);
  if(requestedView&&!pending)await chooseView(requestedView);
});
