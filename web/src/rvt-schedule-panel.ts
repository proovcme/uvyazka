import {reconstructSchedule,previewValue,previewCsv} from './rvt-schedule';
import type {NativeRecord,RvtDocument} from './rvt-document';
import type {ScheduleOptions} from './rvt-schedule';
import {scheduleControls} from './rvt-schedule-controls';
import {readScheduleSettings,writeScheduleSettings} from './rvt-schedule-session';
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
export function schedulePreviewPanel(host:HTMLElement,record:NativeRecord,document:RvtDocument,download:(text:string,type:string,name:string)=>void){
 const panel=node('details');panel.id='rvt-preview';panel.append(node('summary','Сверочная ведомость по элементам'));host.append(panel);
 panel.append(node('p','Строки строятся по параметрам экземпляров и типов с совпадением ID категории либо как многокатегорийная выборка. Длины из подтверждённых слотов показаны в мм; CSV сохраняет исходные значения и единицы. Это предварительная выборка, а не пересчитанная спецификация Revit.'));
 const build=node('button','Построить сверочную ведомость');panel.append(build);
 build.disabled=!document.schedule_data;
 if(!document.schedule_data)panel.append(node('p','Параметры ещё не прочитаны или недоступны.'));
 const content=node('div');panel.append(content);
 const sha=document.source?.sha256??'',scheduleId=String(record.identity.element_id),storageKey=`uvyazka-schedule-review-v1:${sha}:${scheduleId}`;
 let settings:ScheduleOptions={grouping:'schedule',filters:[],sum_fields:[]},storageError='',rowPage=0,colPage=0;
 try{if(sha)settings=readScheduleSettings(localStorage.getItem(storageKey),sha,scheduleId);}catch(e){storageError=`Не удалось восстановить настройки: ${String(e)}`;}
 const render=()=>{
  const report=reconstructSchedule(record,document,settings);content.replaceChildren();
  content.append(node('h3',`Прошли условия: ${report.passed_instances} · неизвестно: ${report.unknown_instances} · исключено: ${report.excluded_instances}`));
  content.append(node('p',`Экземпляров: ${report.instance_count} · строк: ${report.rows.length}. Полнота модели не подтверждена.`));
  const note=node('details');note.className='rvt-notice';note.append(node('summary',`Частичная ведомость · ограничения (${report.issues.length})`));note.open=report.unknown_instances>0||!report.rows.length;for(const issue of report.issues)note.append(node('p',issue));content.append(note);
  content.append(node('p',storageError||'Настройки сохраняются локально для этой модели и таблицы; синхронизации с базой проекта пока нет.'));
  scheduleControls(content,report,settings,()=>{rowPage=0;try{if(!sha)throw new Error('Нет SHA-256 модели');localStorage.setItem(storageKey,writeScheduleSettings(settings,sha,scheduleId));storageError='';}catch(e){storageError=`Настройки действуют до закрытия окна; сохранение не удалось: ${String(e)}`;}render();});
  const csv=node('button','Ведомость CSV'),json=node('button','Ведомость JSON');csv.disabled=!report.rows.length;json.disabled=!document.schedule_data;
  csv.onclick=()=>download(previewCsv(report),'text/csv',`rvt-preview-${record.identity.element_id}.csv`);
  json.onclick=()=>download(JSON.stringify(report,null,2),'application/json',`rvt-preview-${record.identity.element_id}.json`);content.append(csv,json);
  const toolbar=node('div');toolbar.className='rvt-grid-controls';content.append(toolbar);
  toolbar.append(node('small',`Строки ${report.rows.length?rowPage+1:0}–${Math.min(rowPage+50,report.rows.length)} из ${report.rows.length}; поля ${report.columns.length?colPage+1:0}–${Math.min(colPage+8,report.columns.length)} из ${report.columns.length}`));
  for(const [name,disabled,action] of [
   ['← Строки',rowPage===0,()=>{rowPage=Math.max(0,rowPage-50);render();}],['Строки →',rowPage+50>=report.rows.length,()=>{rowPage+=50;render();}],
   ['← Поля',colPage===0,()=>{colPage=Math.max(0,colPage-8);render();}],['Поля →',colPage+8>=report.columns.length,()=>{colPage+=8;render();}]
  ] as [string,boolean,()=>void][]){const b=node('button',name);b.disabled=disabled;b.onclick=action;toolbar.append(b);}
  const wrap=node('div');wrap.className='rvt-table-scroll';const t=node('table'),thead=node('thead'),head=node('tr'),body=node('tbody');head.append(node('th','Экземпляры / тип'),node('th','Отбор'));
  const cols=report.columns.slice(colPage,colPage+8);for(const c of cols)head.append(node('th',String(c.properties.m_columnHeading??c.id??c.order)));thead.append(head);
  const evidence=node('details'),summary=node('summary','Источник выбранного значения'),pre=node('pre');evidence.append(summary,pre);
  for(const row of report.rows.slice(rowPage,rowPage+50)){
   const tr=node('tr'),identity=node('td',`${row.element_ids.length===1?'#'+row.element_ids[0]:row.element_ids.length+' экз.'} / тип #${row.type_id??'разные / не прочитан'}`);tr.append(identity,node('td',row.membership==='pass'?'Прошёл условия':'Неизвестно'));
   row.cells.slice(colPage,colPage+8).forEach((cell,i)=>{
    const td=node('td'),b=node('button',previewValue(cell));b.className='rvt-cell';b.dataset.state=cell.state;
    b.setAttribute('aria-label',`${cols[i].properties.m_columnHeading??cols[i].id}; ${row.element_ids.length===1?'экземпляр #'+row.element_ids[0]:'тип #'+row.type_id+', '+row.element_ids.length+' экз.'}: ${previewValue(cell)}`);
    b.onclick=()=>{summary.textContent=`Источник: ${cols[i].properties.m_columnHeading??cols[i].id}`;pre.textContent=JSON.stringify({source:report.source,schedule_id:report.schedule_id,field:cols[i],element_ids:row.element_ids,type_id:row.type_id,cell},null,2);evidence.open=true;};td.append(b);tr.append(td);
   });body.append(tr);
  }
  t.append(thead,body);wrap.append(t);content.append(wrap,evidence);
 };
 build.onclick=()=>{build.hidden=true;render();};
}
