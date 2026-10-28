import {ProcessingState,duration} from './processing-state';
import type {RunState} from './import-journal';
import {batchSummary} from './import-batch.ts';
import type {BatchSnapshot} from './import-batch.ts';
const labels={running:'Обработка файла',completed:'Готово',partial:'Открыто частично',failed:'Не удалось обработать',cancelled:'Отменено',interrupted:'Прервано'};
const stepLabels={waiting:'Ожидает',active:'В работе',done:'Завершён',skipped:'Пропущен',stopped:'Остановлен'};
export function processingPanel(cancel:()=>void,openLog:()=>void){
  const state=new ProcessingState();let used=false,batch:BatchSnapshot|null=null;
  const dialog=document.createElement('dialog');dialog.id='conversion-dialog';dialog.className='conversion-dialog';dialog.setAttribute('aria-labelledby','conversion-title');
  dialog.innerHTML=`<header class="panel-head"><h2 id="conversion-title">Обработка файла</h2><button id="conversion-close" aria-label="Свернуть окно обработки">Свернуть</button></header><div class="conversion-body"><p id="conversion-source"></p><div class="conversion-stage" role="status" aria-live="polite"><span id="conversion-badge"></span><strong id="conversion-stage"></strong><p id="conversion-message"></p></div><progress id="conversion-progress" aria-label="Выполняется текущий этап"></progress><div class="conversion-timers"><span>Всего <b id="conversion-total">0:00</b></span><span>Текущий этап <b id="conversion-time">0:00</b></span></div><p id="conversion-activity"></p><ol id="conversion-steps" aria-label="Этапы обработки"></ol><p class="conversion-privacy">Файл обрабатывается на вашем устройстве. Время завершения заранее неизвестно.</p><div class="conversion-actions"><button id="conversion-log">Открыть журнал</button><button id="conversion-cancel">Отменить обработку</button><button id="conversion-done" hidden>К модели</button></div></div>`;
  document.body.append(dialog);
  const batchBox=document.createElement('section');batchBox.className='conversion-batch';batchBox.hidden=true;batchBox.setAttribute('aria-label','Очередь файлов');dialog.querySelector('#conversion-steps')!.after(batchBox);
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>dialog.querySelector<T>('#'+id)!;
  const reopen=document.createElement('button');reopen.id='open-processing';reopen.textContent='Обработка';reopen.hidden=true;document.getElementById('status-details')!.after(reopen);
  const open=()=>{if(!dialog.open)dialog.showModal();};reopen.onclick=open;el('conversion-close').onclick=()=>dialog.close();
  el('conversion-cancel').onclick=cancel;el('conversion-done').onclick=()=>dialog.close();el('conversion-log').onclick=()=>{dialog.close();openLog();};
  function render(){
    if(!used)return;const snap=state.snapshot(Date.now()),running=state.state==='running';
    dialog.dataset.state=state.state;el('conversion-title').textContent=labels[state.state];el('conversion-badge').textContent=running?'Выполняется':labels[state.state];
    el('conversion-source').textContent=state.filename+' · '+(state.size/1024**2).toFixed(1)+' MiB';el('conversion-stage').textContent=state.stage;
    el('conversion-message').textContent=state.message;el('conversion-total').textContent=duration(snap.elapsed);el('conversion-time').textContent=duration(snap.stageElapsed);
    const activity=el('conversion-activity');activity.dataset.silent=String(snap.silent);
    activity.textContent=!running?'Результат и события сохранены в журнале.':snap.silent?'Новых ответов движка нет '+duration(Math.max(0,Date.now()-Math.max(state.lastReply,state.lastUpdate)))+'. Тяжёлый этап может выполняться без промежуточных сообщений. Зависание не исключено; можно подождать или отменить.':snap.replyAge!==null?'Последний ответ движка '+duration(snap.replyAge)+' назад.':'Ожидаем первый ответ движка. Таймер показывает время ожидания.';
    el('conversion-progress').hidden=!running;el('conversion-cancel').hidden=!running;el('conversion-done').hidden=running;
    reopen.textContent=running?'Обработка · '+duration(snap.elapsed):labels[state.state];
    el('conversion-steps').replaceChildren(...state.steps.map(step=>{const li=document.createElement('li');li.dataset.state=step.state;const name=document.createElement('span');name.textContent=step.name;const status=document.createElement('small');status.textContent=stepLabels[step.state];li.append(name,status);if(step.state==='active')li.setAttribute('aria-current','step');return li;}));
    batchBox.hidden=!batch;
    if(batch){
      el('conversion-total').textContent=duration(Math.max(0,(batch.ended_at_ms??Date.now())-batch.started_at_ms));
      const summary=document.createElement('strong');summary.textContent=batch.finished?batchSummary(batch):`Очередь: ${batch.rows.filter(row=>!['waiting','running'].includes(row.state)).length} из ${batch.rows.length} обработано`;
      const list=document.createElement('ul');
      const names={waiting:'Ожидает',running:'Читается',completed:'Открыт',partial:'Частично',failed:'Ошибка',cancelled:'Отменён',interrupted:'Прерван'};
      for(const row of batch.rows){const li=document.createElement('li');li.dataset.state=row.state;const name=document.createElement('span'),status=document.createElement('small');name.textContent=row.name;status.textContent=names[row.state];li.append(name,status);if(row.message){li.title=row.message;if(row.state==='failed'){const reason=document.createElement('p');reason.textContent=row.message;li.append(reason);}}list.append(li);}
      batchBox.replaceChildren(summary,list);
      if(batch.finished){const title=batch.rows.some(row=>row.included)?batch.rows.every(row=>row.included&&row.state==='completed')?'Пакет открыт':'Пакет открыт частично':batch.cancelled?'Открытие остановлено':'Файлы не открыты';el('conversion-title').textContent=title;el('conversion-badge').textContent=title;el('conversion-stage').textContent='Итог очереди';el('conversion-message').textContent='Результат каждого файла — ниже. Подробности сохранены в журнале.';el('conversion-source').textContent='Пакет · '+batch.rows.length+' файлов · '+(batch.rows.reduce((n,row)=>n+row.size,0)/1024**2).toFixed(1)+' MiB';reopen.textContent=title;}
    }
  }
  const timer=setInterval(()=>{if(state.state==='running'&&(dialog.open||used))render();},1000);addEventListener('pagehide',()=>clearInterval(timer));
  return {batch(value:BatchSnapshot|null){
    batch=value;
    if(value&&!value.finished&&value.rows.every(row=>row.state==='waiting')){state.begin('Пакет файлов',value.rows.reduce((n,row)=>n+row.size,0),Date.now());used=true;reopen.hidden=false;open();}
    if(value?.finished&&state.state==='running')state.finish(value.cancelled?'cancelled':value.rows.some(row=>row.included)?'partial':'failed',batchSummary(value),Date.now());
    render();
  },begin(filename:string,size:number,simulation=false){if(simulation)batch=null;state.begin(filename,size,Date.now(),simulation);used=true;reopen.hidden=false;render();open();},update(stage:string,message:string){state.update(stage,message,Date.now());render();},reply(){state.reply(Date.now());},finish(result:Exclude<RunState,'running'>,message:string){state.finish(result,message,Date.now());render();},open};
}
