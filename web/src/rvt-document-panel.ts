import {schedulePreviewPanel} from './rvt-schedule-panel';
import {category,fields,recordName,schedule,scheduleCsv,sheetPlacements,identifier,viewOrientation,scheduleGrids,savedCellState} from './rvt-document';
import type {RvtDocument,NativeRecord} from './rvt-document';
const labels:Record<string,string>={all:'Всё содержимое',views:'Планы и разрезы','3d':'3D-виды',sheets:'Листы',schedules:'Спецификации',templates:'Шаблоны',placements:'Размещения',other:'Другие виды'};
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
export function rvtDocumentPanel(orient:(record:NativeRecord)=>void,whole:()=>void){
 const dialog=node('dialog');dialog.id='rvt-document';dialog.className='rvt-document';dialog.setAttribute('aria-labelledby','rvt-document-title');
 dialog.innerHTML=`<div class="panel-head"><div><small>СОДЕРЖИМОЕ RVT</small><h2 id="rvt-document-title">Виды и таблицы</h2></div><button id="rvt-document-close" aria-label="Закрыть виды и таблицы">✕</button></div><p id="rvt-document-status" role="status"></p><div class="rvt-document-tools"><button id="rvt-whole">Вся прочитанная модель</button><button id="rvt-export">Скачать каталог JSON</button></div><div class="rvt-document-layout"><nav aria-label="Каталог RVT"><label>Раздел<select id="rvt-kind"></select></label><label>Поиск<input id="rvt-search" type="search" placeholder="Имя или ElementId"></label><div id="rvt-records"></div><button id="rvt-more" hidden>Показать ещё 100</button></nav><article id="rvt-record-detail"></article></div>`;
 document.body.append(dialog);const get=<T extends HTMLElement=HTMLElement>(id:string)=>dialog.querySelector<T>('#'+id)!;
 const button=node('button','Виды и таблицы');button.id='open-rvt-document';button.onclick=()=>dialog.showModal();document.getElementById('reset-visibility')!.after(button);
 let data:RvtDocument|null=null,selected:NativeRecord|null=null,shown=100,geometry=false,downloadUrl='';
 for(const [value,label] of Object.entries(labels))get<HTMLSelectElement>('rvt-kind').add(new Option(label,value));
 get('rvt-document-close').onclick=()=>dialog.close();
 get('rvt-whole').onclick=()=>{whole();dialog.close();};
 const download=(value:string,type:string,name:string)=>{if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(new Blob([value],{type}));const a=node('a');a.href=downloadUrl;a.download=name;a.click();};
 get('rvt-export').onclick=()=>{if(data)download(JSON.stringify(data,null,2),'application/json','uvyazka-rvt-document.json');};
 function details(host:HTMLElement,title:string,value:unknown){const d=node('details'),s=node('summary',title),pre=node('pre',JSON.stringify(value,null,2));d.append(s,pre);host.append(d);}
 function table(host:HTMLElement,headers:string[],rows:unknown[][]){const wrap=node('div'),t=node('table'),head=node('thead'),tr=node('tr'),body=node('tbody');wrap.className='rvt-table-scroll';headers.forEach(h=>tr.append(node('th',h)));head.append(tr);for(const row of rows){const r=node('tr');row.forEach(v=>r.append(node('td',v===null||v===undefined?'Не прочитано':typeof v==='object'?JSON.stringify(v):String(v))));body.append(r);}t.append(head,body);wrap.append(t);host.append(wrap);}
 function show(record:NativeRecord){
  selected=record;list();const host=get('rvt-record-detail');host.replaceChildren();const f=fields(record),kind=category(record);
  host.append(node('small',`${labels[kind]} · #${record.identity.element_id}`),node('h2',recordName(record)));
  host.append(node('p',record.graph?'Сохранённая запись прочитана':'Данные записи недоступны'));
  if(record.diagnostic)host.append(node('p',record.diagnostic));
  if(!record.graph)host.append(node('p','Граф этой записи не прочитан. Пустое содержимое не означает отсутствие данных в RVT.'));
  const exportButton=node('button','Запись JSON');exportButton.onclick=()=>download(JSON.stringify({source:data?.source,record},null,2),'application/json',`rvt-${record.identity.element_id}.json`);host.append(exportButton);
  if(record.kind==='schedule'){
   if(data)schedulePreviewPanel(host,record,data,download);
   const s=schedule(record);const note=node('p','Ниже — сохранённые ячейки RVT, без пересчёта. Сверочная ведомость выше строится отдельно; формулы, нативные фильтры и точное оформление Revit пока не воспроизводятся.');note.className='rvt-notice';host.append(note);
   const csv=node('button','Ячейки CSV');csv.disabled=!s.cells.length;csv.onclick=()=>download(scheduleCsv(record),'text/csv',`rvt-schedule-${record.identity.element_id}.csv`);host.append(csv);
   const definition=node('details'),definitionTitle=node('summary',`Поля спецификации · ${s.columns.length}`);definition.append(definitionTitle);host.append(definition);
   if(s.columns.length)table(definition,['Порядок в RVT','ID','Заголовок','Скрыто','Параметр'],s.columns.map(c=>[c.order,c.id,c.properties.m_columnHeading,typeof c.properties.m_hidden==='boolean'?(c.properties.m_hidden?'Да':'Нет'):null,identifier(c.properties.m_paramElemId)]));
   for(const issue of s.issues)host.append(node('p',issue));
   host.append(node('h3',`Сохранённые ячейки · ${s.cells.length}`));
   if(!s.cells.length)host.append(node('p','Сохранённых ячеек не получено. Это не пустая спецификация и не нулевые количества.'));
   if(s.cells.length)host.append(node('p','Номера строк и колонок — исходные. «Пустая» — сохранён пустой текст; «Нет данных» — записи в этой позиции нет среди прочитанных. Нажмите ячейку для проверки источника. Объединение и оформление не реконструируются.'));
   for(const grid of scheduleGrids(s.cells)){
    const section=node('section');section.className='rvt-schedule-grid';section.append(node('h4',`Секция ${JSON.stringify(grid.section)??'неизвестна'}`));host.append(section);
    const toolbar=node('div');toolbar.className='rvt-grid-controls';const area=node('div');area.className='rvt-table-scroll';const evidence=node('details'),caption=node('summary','Источник выбранной ячейки'),pre=node('pre','Выберите ячейку таблицы.');evidence.append(caption,pre);section.append(toolbar,area,evidence);
    let rowOffset=0,columnOffset=0;
    const controls=()=>{
     toolbar.replaceChildren();toolbar.append(node('small',`Строки ${grid.rows.length?rowOffset+1:0}–${Math.min(rowOffset+50,grid.rows.length)} из ${grid.rows.length}; колонки ${grid.columns.length?columnOffset+1:0}–${Math.min(columnOffset+12,grid.columns.length)} из ${grid.columns.length}`));
     for(const [label,disabled,action] of [
      ['← Строки',rowOffset===0,()=>{rowOffset=Math.max(0,rowOffset-50);render();}],['Строки →',rowOffset+50>=grid.rows.length,()=>{rowOffset+=50;render();}],
      ['← Колонки',columnOffset===0,()=>{columnOffset=Math.max(0,columnOffset-12);render();}],['Колонки →',columnOffset+12>=grid.columns.length,()=>{columnOffset+=12;render();}]
     ] as [string,boolean,()=>void][]){const b=node('button',label);b.disabled=disabled;b.onclick=action;toolbar.append(b);}
    };
    const render=()=>{
     controls();area.replaceChildren();const t=node('table'),head=node('thead'),header=node('tr'),body=node('tbody');header.append(node('th','Строка / колонка'));const columns=grid.columns.slice(columnOffset,columnOffset+12);for(const col of columns)header.append(node('th',String(col)));head.append(header);
     for(const row of grid.rows.slice(rowOffset,rowOffset+50)){const tr=node('tr'),label=node('th',String(row));label.scope='row';tr.append(label);
      for(const column of columns){const entries=grid.cells.get(`${row}:${column}`)??[],state=savedCellState(entries),td=node('td'),value=state==='text'?entries[0].text!:({missing:'Нет данных',conflict:`Конфликт: ${entries.length} записей`,unreadable:'Текст не прочитан',empty:'Пустая'} as Record<string,string>)[state];
       const b=node('button',value);b.className='rvt-cell';b.dataset.state=state;b.setAttribute('aria-label',`Строка ${row}, колонка ${column}: ${value}`);b.onclick=()=>{caption.textContent=`Источник: строка ${row}, колонка ${column}`;pre.textContent=JSON.stringify({source:data?.source,element_id:record.identity.element_id,section:grid.section,row,column,status:state,cells:entries},null,2);evidence.open=true;};td.append(b);tr.append(td);
      }body.append(tr);
     }t.append(head,body);area.append(t);
    };render();
    if(grid.unpositioned.length){section.append(node('p',`${grid.unpositioned.length} ячеек без достоверных координат — сохранены отдельно.`));details(section,'Ячейки с неизвестным положением',grid.unpositioned);}
   }
   details(host,'Определение, фильтры и сортировка (исходные поля)',{definition:s.schema,resolved_rules:s.rules});
   details(host,'Поля и ячейки с адресами источников',s);
  }else if(kind==='sheets'){
   host.append(node('p',`Номер листа: ${f.m_sheetNumber}`),node('p','Состав листа по сохранённым размещениям. Рамка, аннотации и графика листа пока не отрисовываются.'));
   const placements=sheetPlacements(record,data?.records??[]);host.append(node('h3',`Размещения · ${placements.length}`));
   if(!placements.length)host.append(node('p','Явные связи размещений не найдены; полнота листа неизвестна.'));
   for(const p of placements){const pf=fields(p),target=identifier(pf.m_dbViewId??pf.m_scheduleId??pf.m_internalScheduleId),linked=data?.records.find(r=>String(r.identity.element_id)===target);const b=node('button',linked?`${recordName(linked)} · размещение #${p.identity.element_id}`:`Размещение #${p.identity.element_id} · вид ${target??'не прочитан'}`);b.onclick=()=>show(linked??p);host.append(b);}
  }else{
   const orientation=viewOrientation(record);
   if(orientation){const b=node('button','Показать ориентацию на модели');b.disabled=!geometry;b.onclick=()=>{orient(record);dialog.close();};host.append(b);host.append(node('p','Реконструкция ориентации по направлениям вида. Обрезка, масштаб листа, фильтры видимости, шаблон и аннотации не применяются.'));}
   const names:Record<string,string>={m_viewName:'Имя',m_viewDescription:'Описание',m_scale:'Масштаб (исходный коэффициент)',m_isTemplate:'Шаблон',m_viewTemplateId:'ID шаблона',m_origin:'Начало координат (исходные единицы)',m_viewDir:'Направление взгляда',m_horzDir:'Горизонталь вида',m_vertDir:'Вертикаль вида',m_cutPlaneElev:'Высота сечения (исходные единицы)',m_topClipElev:'Верхняя граница',m_bottomClipElev:'Нижняя граница',m_dbViewId:'ID вида',m_dbDrawingId:'ID чертежа',m_scheduleId:'ID спецификации',m_sheetNumber:'Номер листа'};
   table(host,['Свойство','Сохранённое значение'],Object.entries(f).filter(([k])=>/^m_(viewName|viewDescription|scale|isTemplate|viewTemplateId|origin|viewDir|horzDir|vertDir|cutPlaneElev|topClipElev|bottomClipElev|dbViewId|dbDrawingId|scheduleId|sheetNumber)$/.test(k)).map(([k,v])=>[names[k]||k,typeof v==='boolean'?(v?'Да':'Нет'):/Id$/.test(k)?identifier(v):v]));
  }
  details(host,'Происхождение записи',{source:data?.source,identity:record.identity,location:record.source,schema_sha256:data?.schema_sha256});
  details(host,'Все сохранённые поля и связи',record.graph);
 }
 function list(){const host=get('rvt-records');host.replaceChildren();const query=get<HTMLInputElement>('rvt-search').value.toLocaleLowerCase(),kind=get<HTMLSelectElement>('rvt-kind').value;
  const rows=(data?.records??[]).filter(r=>(kind==='all'||category(r)===kind)&&`${recordName(r)} ${r.identity.element_id} ${r.class_name}`.toLocaleLowerCase().includes(query));
  host.append(node('small',`Найдено: ${rows.length}`));for(const r of rows.slice(0,shown)){const b=node('button');b.setAttribute('aria-pressed',String(r===selected));b.append(node('span',recordName(r)),node('small',`${labels[category(r)]} · #${r.identity.element_id}`));b.onclick=()=>show(r);host.append(b);}get('rvt-more').hidden=rows.length<=shown;
 }
 get('rvt-more').onclick=()=>{shown+=100;list();};for(const id of ['rvt-search','rvt-kind'])get(id).oninput=()=>{shown=100;selected=null;get('rvt-record-detail').replaceChildren(node('p','Выберите запись в каталоге.'));list();};
 function set(next:RvtDocument|null,message='Загрузите RVT, чтобы прочитать виды, листы и таблицы.') {data=next;selected=null;geometry=false;get<HTMLButtonElement>('rvt-whole').disabled=true;get<HTMLButtonElement>('rvt-export').disabled=!data;get('rvt-record-detail').replaceChildren(node('p','Выберите запись в каталоге.'));get('rvt-document-status').textContent=data?`${data.source?.filename??'RVT'} · ${data.records.length} записей · ${data.status==='partial'?'Прочитано частично':'Каталог прочитан'}${data.error?' · '+data.error:''} · Полнота документа не подтверждена. Каталог кешируется в этом браузере по SHA-256.`:message;list();}
 set(null);
 return {set,geometryReady:(ready:boolean)=>{geometry=ready;get<HTMLButtonElement>('rvt-whole').disabled=!ready;if(selected)show(selected);},open:()=>dialog.showModal()};
}
