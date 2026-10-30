import type {ModelPackage} from './model';
import {dataRows,dataSnapshot,parameterCsv,rowQuantities} from './model-data';
import type {DataSection,DataRow} from './model-data';
import {matchesDataQuery} from './element-identity';
import {copyValue} from './copy-properties';
import {addDiagnostics,displayClass,displayElementName} from './ui-language.ts';
import {propertySections} from './property-sections.ts';

export function modelDataPanel(getModel:()=>ModelPackage|null,select:(id:string)=>void){
  const dialog=document.createElement('dialog');dialog.className='model-data';dialog.setAttribute('aria-labelledby','model-data-title');
  dialog.innerHTML=`<div class="panel-head"><h2 id="model-data-title">Данные модели</h2><button data-close aria-label="Закрыть данные">✕</button></div>
  <div class="model-data-summary" role="status"></div><div class="model-data-controls"><label>Таблица<select data-section><option value="elements">Элементы</option><option value="rooms">Помещения</option><option value="storeys">Этажи</option><option value="systems">Системы</option></select></label><label class="model-data-query">Поиск по именам, ID и параметрам<input data-query type="search" placeholder="Revit ID, марка, материал, мощность…"></label><button data-json>JSON данных</button><button data-csv>CSV параметров</button></div>
  <p class="model-data-note">Параметры из исходного файла. Непрочитанные значения отмечены отдельно.</p>
  <div class="model-data-layout"><div class="model-data-table"></div><div class="model-data-detail"><p>Выберите строку, чтобы прочитать все её параметры и источник.</p></div></div><div class="model-data-footer"><span></span><button data-prev>Назад</button><button data-next>Далее</button></div>`;
  document.body.append(dialog);const advanced=document.createElement('details'),advancedTitle=document.createElement('summary');advancedTitle.textContent='Диагностика и экспорт исходных данных';advanced.append(advancedTitle,dialog.querySelector('[data-json]')!);dialog.querySelector('.model-data-controls')!.after(advanced);
  const button=document.createElement('button');button.id='open-model-data';button.textContent='Данные модели';document.getElementById('theme-toggle')!.before(button);
  const node=<T extends HTMLElement=HTMLElement>(selector:string)=>dialog.querySelector<T>(selector)!;
  let rows:DataRow[]=[],filtered:DataRow[]=[],offset=0,timer:ReturnType<typeof setTimeout>|undefined;
  const tables=new WeakMap<ModelPackage,Map<DataSection,DataRow[]>>();
  const section=()=>node<HTMLSelectElement>('[data-section]').value as DataSection;
  const cell=(text:unknown)=>{const td=document.createElement('td');td.textContent=String(text??'—');return td;};
  const render=()=>{
    const q=node<HTMLInputElement>('[data-query]').value.trim().toLocaleLowerCase();
    filtered=q?rows.filter(r=>matchesDataQuery(r.record,q)):rows;
    offset=Math.min(offset,Math.max(0,Math.floor((filtered.length-1)/50)*50));
    const table=document.createElement('table');table.innerHTML='<thead><tr><th>Наименование / ID</th><th>Revit ElementId</th><th>Класс</th><th>Этаж / состав</th><th>Величины из источника</th></tr></thead>';
    const tbody=document.createElement('tbody');
    for(const row of filtered.slice(offset,offset+50)){
      const tr=document.createElement('tr'),td=document.createElement('td'),choose=document.createElement('button');choose.textContent=displayElementName(row.name,row.type,(row.record.revit_identity as {element_id?:string})?.element_id);
      choose.onclick=()=>{
        const detail=node('.model-data-detail');detail.replaceChildren();
        const title=document.createElement('h3');title.textContent=choose.textContent;detail.append(title);
        const copy=document.createElement('button');copy.textContent='Копировать все свойства';copy.dataset.copy=JSON.stringify(row.record,null,2);detail.append(copy);
        if(section()==='elements'||section()==='rooms'){const show=document.createElement('button');show.textContent='Свойства в модели';show.onclick=()=>{dialog.close();select(row.id);};detail.append(show);}
        const info=document.createElement('dl'),add=(name:string,value:unknown)=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.innerHTML=copyValue(value);info.append(dt,dd);};
        const identity=row.record.revit_identity as {element_id?:string;unique_id?:string}|undefined;
        if(identity?.element_id)add('Revit ElementId',identity.element_id);if(identity?.unique_id)add('Revit UniqueId',identity.unique_id);if(row.record.global_id)add('IFC GlobalId',row.record.global_id);
        add('Категория',displayClass(row.type));add('Этаж / состав',row.level);if(row.record.description)add('Описание',row.record.description);if(typeof row.record.elevation_m==='number')add('Отметка, м',row.record.elevation_m);detail.append(info);
        for(const key of ['quantity_sets','property_sets']){const sets=row.record[key];if(sets&&typeof sets==='object'){const groups=document.createElement('div');groups.innerHTML=propertySections(sets as Record<string,Record<string,unknown>>);detail.append(groups);}}
        addDiagnostics(detail,()=>row.record);
      };
      const revit=(row.record.revit_identity as {element_id?:string}|undefined)?.element_id;
      const identity=cell('Не прочитан');if(revit)identity.innerHTML=copyValue(revit);
      td.append(choose);tr.append(td,identity,cell(displayClass(row.type)),cell(row.level),cell(rowQuantities(row)));tbody.append(tr);
    }
    table.append(tbody);const host=node('.model-data-table');host.replaceChildren(table);
    if(!filtered.length){const empty=document.createElement('p');empty.textContent=section()==='systems'?'Системы в этой выгрузке не прочитаны. Это не доказывает их отсутствие в исходном проекте.':'В этой выборке записей нет. Отсутствие записи не равно нулевому значению.';host.append(empty);}
    node('.model-data-footer span').textContent=`${filtered.length} записей · показаны ${filtered.length?offset+1:0}–${Math.min(offset+50,filtered.length)}`;
    node<HTMLButtonElement>('[data-prev]').disabled=offset===0;node<HTMLButtonElement>('[data-next]').disabled=offset+50>=filtered.length;
  };
  const refresh=()=>{
    const model=getModel();rows=[];if(model){let cached=tables.get(model);if(!cached){cached=new Map();tables.set(model,cached);}let table=cached.get(section());if(!table){table=dataRows(model,section());cached.set(section(),table);}rows=table;}offset=0;
    node('.model-data-summary').textContent=model?`Источник: ${model.source.filename}`:'Откройте модель, чтобы посмотреть её параметры.';
    node('.model-data-detail').replaceChildren();render();
  };
  const save=(kind:'json'|'csv')=>{const model=getModel();if(!model)return;const blob=new Blob([kind==='json'?JSON.stringify(dataSnapshot(model,section(),filtered),null,2):parameterCsv(model,filtered)],{type:kind==='json'?'application/json':'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`uvyazka-${section()}.${kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  button.onclick=()=>{refresh();dialog.showModal();};node('[data-close]').onclick=()=>dialog.close();
  node('[data-section]').onchange=refresh;node('[data-query]').oninput=()=>{clearTimeout(timer);offset=0;timer=setTimeout(render,200);};
  node('[data-prev]').onclick=()=>{offset=Math.max(0,offset-50);render();};node('[data-next]').onclick=()=>{offset+=50;render();};
  node('[data-json]').onclick=()=>save('json');node('[data-csv]').onclick=()=>save('csv');
  document.addEventListener('model-data-changed',()=>{if(dialog.open)refresh();});
}
