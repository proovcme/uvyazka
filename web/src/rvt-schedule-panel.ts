import {reconstructSchedule,previewValue,previewCsv} from './rvt-schedule';
import type {NativeRecord,RvtDocument} from './rvt-document';
import {schedule} from './rvt-document';
import {userMessage} from './ui-language.ts';
import type {ScheduleOptions} from './rvt-schedule';
import {scheduleControls} from './rvt-schedule-controls';
import {readScheduleSettings,writeScheduleSettings} from './rvt-schedule-session';
import {nativeFilterSummary} from './rvt-native-filter';
import {renderCellSource,rowNeedsReview} from './cell-source';
import type {scheduleSceneSelection} from './schedule-scene';
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
export function schedulePreviewPanel(host:HTMLElement,record:NativeRecord,document:RvtDocument,download:(text:string,type:string,name:string)=>void,actions:{resolve?:(source:string,ids:string[])=>ReturnType<typeof scheduleSceneSelection>;show?:(source:string,ids:string[])=>void}={}){
 if(!record.graph||!schedule(record).columns.length){host.append(node('p','Не удалось прочитать столбцы этой спецификации.'));return;}
 const panel=node('details');panel.id='rvt-preview';panel.open=true;panel.append(node('summary','Сверочная ведомость по элементам'));host.append(panel);
 const native=nativeFilterSummary(record),conditions=node('details');conditions.className='rvt-notice';
 conditions.append(node('summary',native.count===0?'Исходные фильтры RVT: нет':`Исходные фильтры RVT · ${native.count??'не прочитаны'}`));
 conditions.append(node('p',native.complete?'Поддержанные исходные условия применяются совместно (И), до группировки. Дополнительные фильтры сверки их не заменяют.':'Не все исходные условия удалось прочитать. Состав оставшихся строк не подтверждён; неизвестные строки не включаются в контрольные суммы.'));
 for(const rule of native.rows)conditions.append(node('p',`${rule.field}${rule.hidden?' (скрытое поле)':''}: ${rule.condition}${rule.value===undefined?'':' '+JSON.stringify(rule.value)}${rule.storage==='Double'?' (исходные единицы)':''}${rule.state==='unknown'?' · требует проверки':''}`));
 panel.append(conditions);
 panel.append(node('p','Предварительная таблица по данным модели. Исходные фильтры учитываются; формулы и оформление Revit восстанавливаются не полностью.'));
 const build=node('button','Построить сверочную ведомость');panel.append(build);
 build.disabled=!document.schedule_data;
 if(!document.schedule_data)panel.append(node('p','Параметры ещё не прочитаны или недоступны.'));
 const content=node('div');panel.append(content);
 const sha=document.source?.sha256??'',scheduleId=String(record.identity.element_id),storageKey=`uvyazka-schedule-review-v1:${sha}:${scheduleId}`;
 let settings:ScheduleOptions={grouping:'schedule',filters:[],sum_fields:[]},storageError='',rowPage=0,colPage=0,questionsOnly=false,cached:ReturnType<typeof reconstructSchedule>|null=null;
 try{if(sha)settings=readScheduleSettings(localStorage.getItem(storageKey),sha,scheduleId);}catch(e){storageError=`Не удалось восстановить настройки: ${String(e)}`;}
 const render=()=>{
  const report=cached??(cached=reconstructSchedule(record,document,settings));content.replaceChildren();
  const displayed=questionsOnly?report.rows.filter(r=>rowNeedsReview(r.cells,r.membership)):report.rows;
  rowPage=Math.min(rowPage,Math.max(0,Math.floor((displayed.length-1)/50)*50));
  content.append(node('h3',`Прошли условия: ${report.passed_instances} · неизвестно: ${report.unknown_instances} · исключено: ${report.excluded_instances}`));
  content.append(node('p',`Элементов: ${report.instance_count} · строк: ${report.rows.length}. ${report.unknown_instances?'Есть строки с неподтверждённым составом; они не входят в контрольные суммы.':'Результат предварительный и требует сверки.'}`));
  const technical=node('details');technical.append(node('summary','Технические данные и ограничения'));
  const note=node('details');note.className='rvt-notice';note.append(node('summary',`Ограничения чтения (${report.issues.length})`));for(const issue of report.issues)note.append(node('p',issue));technical.append(note);
  if(storageError){content.append(node('p',userMessage(storageError,'Не удалось восстановить настройки таблицы. Задайте их заново.')));technical.append(node('pre',storageError));}
  technical.append(node('p','Настройки сохраняются локально для этой модели и таблицы; синхронизации с базой проекта пока нет.'));
  scheduleControls(content,report,settings,()=>{cached=null;rowPage=0;try{if(!sha)throw new Error('Нет SHA-256 модели');localStorage.setItem(storageKey,writeScheduleSettings(settings,sha,scheduleId));storageError='';}catch(e){storageError=`Настройки действуют до закрытия окна; сохранение не удалось: ${String(e)}`;}render();});
  const questionLabel=node('label'),questionToggle=node('input');questionLabel.className='table-review-filter';questionToggle.type='checkbox';questionToggle.checked=questionsOnly;questionToggle.onchange=()=>{questionsOnly=questionToggle.checked;rowPage=0;render();};questionLabel.append(questionToggle,globalThis.document.createTextNode(' Только строки с вопросами'));content.append(questionLabel);
  if(questionsOnly)content.append(node('p','Фильтр меняет только показ строк. Экспорт и контрольные суммы сохраняют весь состав таблицы.'));
  const csv=node('button','Ведомость CSV'),json=node('button','Ведомость JSON');csv.disabled=!report.rows.length;json.disabled=!document.schedule_data;
  csv.onclick=()=>download(previewCsv(report),'text/csv',`rvt-preview-${record.identity.element_id}.csv`);
  json.onclick=()=>download(JSON.stringify(report,null,2),'application/json',`rvt-preview-${record.identity.element_id}.json`);content.append(csv);technical.append(json);
  const audit=content.querySelector('#rvt-selection-audit');if(audit)technical.append(audit);
  const toolbar=node('div');toolbar.className='rvt-grid-controls';content.append(toolbar);
  toolbar.append(node('small',`Строки ${displayed.length?rowPage+1:0}–${Math.min(rowPage+50,displayed.length)} из ${displayed.length}; поля ${report.columns.length?colPage+1:0}–${Math.min(colPage+8,report.columns.length)} из ${report.columns.length}`));
  for(const [name,disabled,action] of [
   ['← Строки',rowPage===0,()=>{rowPage=Math.max(0,rowPage-50);render();}],['Строки →',rowPage+50>=displayed.length,()=>{rowPage+=50;render();}],
   ['← Поля',colPage===0,()=>{colPage=Math.max(0,colPage-8);render();}],['Поля →',colPage+8>=report.columns.length,()=>{colPage+=8;render();}]
  ] as [string,boolean,()=>void][]){const b=node('button',name);b.disabled=disabled;b.onclick=action;toolbar.append(b);}
  const wrap=node('div');wrap.className='rvt-table-scroll';const t=node('table'),thead=node('thead'),head=node('tr'),body=node('tbody');head.append(node('th','Элементы модели'),node('th','Отбор'));
  const cols=report.columns.slice(colPage,colPage+8);for(const c of cols)head.append(node('th',String(c.properties.m_columnHeading??c.id??c.order)));thead.append(head);
  const evidence=node('details'),summary=node('summary','Источник выбранного значения'),sourceHost=node('div');evidence.append(summary,sourceHost);
  for(const row of displayed.slice(rowPage,rowPage+50)){
   const tr=node('tr'),identity=node('td',row.element_ids.length===1?'Revit #'+row.element_ids[0]:row.element_ids.length+' элементов');tr.dataset.needsReview=String(rowNeedsReview(row.cells,row.membership));tr.append(identity,node('td',row.membership==='pass'?'Прошёл условия':'Неизвестно'));
   const mapping=actions.resolve?.(sha,row.element_ids),show=node('button','Показать в модели');show.className='table-show-elements';show.disabled=!mapping?.scene_ids.length||!actions.show;show.title=mapping?.ambiguous_ids.length?'Неоднозначные Revit ID не присоединены':mapping?.scene_ids.length?`Найдена геометрия ${mapping.represented} из ${mapping.requested} элементов`:'Для этой строки геометрия не найдена в том же исходном файле';show.onclick=()=>actions.show?.(sha,row.element_ids);identity.append(show);
   if(mapping&&mapping.represented<mapping.requested)identity.append(node('small',mapping.ambiguous_ids.length?'Есть неоднозначные ID':`Геометрия: ${mapping.represented} из ${mapping.requested}`));
   row.cells.slice(colPage,colPage+8).forEach((cell,i)=>{
    const td=node('td'),b=node('button',previewValue(cell));b.className='rvt-cell';b.dataset.state=cell.state;
    b.setAttribute('aria-label',`${cols[i].properties.m_columnHeading??cols[i].id}; ${row.element_ids.length===1?'экземпляр #'+row.element_ids[0]:'тип #'+row.type_id+', '+row.element_ids.length+' экз.'}: ${previewValue(cell)}`);
    b.onclick=()=>{const field=String(cols[i].properties.m_columnHeading??cols[i].id);summary.textContent=`Источник: ${field}`;
     const evidenceOwners=new Set(cell.evidence.map(e=>e.owner_id)),rowOwners=new Set(row.element_ids);const owners=[...row.element_ids.filter(id=>!evidenceOwners.has(id)).map(id=>({id,label:'Элемент строки · Revit ID'})),...cell.evidence.map(e=>({id:e.owner_id,label:rowOwners.has(e.owner_id)?'Revit ID экземпляра':row.type_id===e.owner_id?'Revit ID типа':'ID источника'}))];
     renderCellSource(sourceHost,{field,value:previewValue(cell),cell,membership:row.membership,sources:report.source?.filename?[report.source.filename]:[],method:cell.evidence.length?(cols[i].properties.m_sourceType===2?'подсчёт элементов':cols[i].properties.m_sourceType===1?'параметр связанного типа':'параметр экземпляра или явно связанного типа'):undefined,owners,show:mapping?.scene_ids.length&&actions.show?()=>actions.show!(sha,row.element_ids):undefined,technical:{source:report.source,schedule_id:report.schedule_id,field:cols[i],element_ids:row.element_ids,type_id:row.type_id,cell,mapping}});evidence.open=true;};td.append(b);tr.append(td);
   });body.append(tr);
  }
  t.append(thead,body);wrap.append(t);content.append(wrap,evidence,technical);if(questionsOnly&&!displayed.length)wrap.append(node('p','Среди показанных полей нет строк с вопросами. Это не подтверждает полноту чтения модели.'));
 };
 build.onclick=()=>{build.hidden=true;render();};
}
