import {ImportJournal,browserJournalStorage,textReport} from './import-journal';
import type {ImportRun} from './import-journal';
const stateLabel={running:'В работе',completed:'Завершено',partial:'Открыто частично',failed:'Ошибка',cancelled:'Отменено',interrupted:'Прервано'};
export function journalPanel(){
  const dialog=document.createElement('dialog');dialog.className='processing-journal';dialog.id='processing-journal';dialog.setAttribute('aria-labelledby','processing-title');
  dialog.innerHTML=`<div class="panel-head"><h2 id="processing-title">Журнал обработки</h2><button id="processing-close" aria-label="Закрыть журнал">✕</button></div>
<div class="journal-controls"><label>Запуск<select id="processing-runs"></select></label><label>События<select id="processing-filter"><option value="all">Все</option><option value="warning">Предупреждения и ошибки</option><option value="error">Ошибки</option></select></label><button id="processing-json">JSON</button><button id="processing-text">TXT</button></div>
<p id="processing-storage" class="journal-storage">История хранится в этом браузере. Показаны последние 30 запусков; геометрия не входит в журнал. Кеш IFC хранится отдельно.</p>
<div id="processing-summary" class="journal-summary" aria-live="polite"></div><div id="processing-events" class="journal-events" role="log" aria-label="События обработки"></div>`;
  document.body.append(dialog);
  const find=<T extends HTMLElement=HTMLElement>(id:string)=>dialog.querySelector<T>('#'+id)!;
  const select=find<HTMLSelectElement>('processing-runs'),filter=find<HTMLSelectElement>('processing-filter');
  let selected='',owner:string=crypto.randomUUID(),storageSetupError='';
  try {owner=sessionStorage.getItem('uvyazka-journal-owner')||owner;sessionStorage.setItem('uvyazka-journal-owner',owner);}catch{storageSetupError='Хранилище сессии недоступно: восстановление прерванных запусков ограничено.';}
  let store;try {store=browserJournalStorage();}catch(error){store={load:async()=>[],save:async()=>{throw error;}};}
  const journal=new ImportJournal(store,owner,()=>{if(dialog.open)render();});
  const current=()=>journal.runs.find(r=>r.id===selected)||journal.runs[0];
  function summary(run?:ImportRun){
    const host=find('processing-summary');host.replaceChildren();
    if(!run){host.textContent='Загрузите модель — здесь появятся этапы, время и результат.';return;}
    const end=run.ended_at?Date.parse(run.ended_at):Date.now();
    const status=document.createElement('strong');status.dataset.state=run.state;status.textContent=stateLabel[run.state]+(run.warnings?` · предупреждений: ${run.warnings}`:'');
    const phase=document.createElement('span');phase.textContent=`${run.stage} · всего ${((end-Date.parse(run.started_at))/1000).toFixed(1)} с · этап ${((end-Date.parse(run.stage_started_at))/1000).toFixed(1)} с`;
    const source=document.createElement('small');source.textContent=`${(run.size_bytes/1024**2).toFixed(1)} MiB · ${run.sha256?'SHA-256 '+run.sha256:'SHA-256 ещё не вычислен'}`;
    host.append(status,phase,source);
    if(run.state==='running'){const note=document.createElement('small');note.textContent='Показывается прошедшее время. Это не оценка процента готовности и не подтверждение, что worker отвечает.';host.append(note);}
    if(run.omitted_events){const note=document.createElement('small');note.textContent=`Вытеснено старых событий: ${run.omitted_events}. Сохранены первое и последние 999 событий.`;host.append(note);}
  }
  function render(){
    const run=current();selected=run?.id||'';
    select.replaceChildren(...journal.runs.slice(0,30).map(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=`${new Date(r.started_at).toLocaleString()} · ${r.filename} · ${stateLabel[r.state]}`;return o;}));select.value=selected;
    find('processing-storage').textContent=journal.storageError||storageSetupError||'История хранится в этом браузере. Показаны последние 30 запусков; геометрия не входит в журнал. Кеш IFC хранится отдельно.';
    find('processing-storage').classList.toggle('journal-warning',!!journal.storageError||!!storageSetupError);
    summary(run);const host=find('processing-events'),nearBottom=host.scrollHeight-host.scrollTop-host.clientHeight<50;
    host.replaceChildren();
    const rows=(run?.events||[]).filter(e=>filter.value==='all'||filter.value==='warning'&&e.level!=='info'||filter.value==='error'&&e.level==='error');
    for(const entry of rows){
      const row=document.createElement('article');row.className='journal-event';row.dataset.level=entry.level;
      const time=document.createElement('time');time.dateTime=entry.at;time.textContent=new Date(entry.at).toLocaleTimeString();time.title=entry.at;
      const duration=document.createElement('span');duration.className='journal-elapsed';duration.textContent=`+${(entry.elapsed_ms/1000).toFixed(1)} с`;
      const body=document.createElement('div'),stage=document.createElement('small'),message=document.createElement('p');
      stage.textContent=entry.stage+' · '+({info:'Информация',warning:'Предупреждение',error:'Ошибка'}[entry.level]);message.textContent=entry.message;body.append(stage,message);
      if(entry.details!==undefined){const detail=document.createElement('details'),label=document.createElement('summary'),pre=document.createElement('pre');label.textContent='Подробности';pre.textContent=JSON.stringify(entry.details,null,2);detail.append(label,pre);body.append(detail);}
      row.append(time,duration,body);host.append(row);
    }
    if(!rows.length)host.textContent=run?'Событий по этому фильтру нет.':'Журнал пока пуст.';
    if(nearBottom)host.scrollTop=host.scrollHeight;
    for(const id of ['processing-json','processing-text'])find<HTMLButtonElement>(id).disabled=!run;
  }
  const ready=journal.restore();
  const open=()=>{render();if(!dialog.open)dialog.showModal();};
  find('processing-close').onclick=()=>dialog.close();select.onchange=()=>{selected=select.value;render();};filter.onchange=render;
  for(const [id,json] of [['processing-json',true],['processing-text',false]] as const)find(id).onclick=()=>{
    const run=current();if(!run)return;const blob=new Blob([json?JSON.stringify({schema_version:1,run},null,2):textReport(run)],{type:json?'application/json':'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`uvyazka-${run.id}.${json?'json':'txt'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const timer=setInterval(()=>{if(dialog.open)summary(current());},1000);addEventListener('pagehide',()=>clearInterval(timer));
  return {journal,ready,open,select:(run:ImportRun)=>{selected=run.id;if(dialog.open)render();}};
}
