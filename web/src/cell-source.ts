import type {ValueCell} from './rvt-schedule';

const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
const states:Record<ValueCell['state'],string>={value:'Значение получено',missing:'Значение не прочитано',conflict:'Найдены противоречащие значения',unsupported:'Правило чтения или расчёта не поддержано',mixed:'В группе разные значения'};
export function rowNeedsReview(cells:(ValueCell&{confirmed?:boolean})[],membership:string){return membership!=='pass'||cells.some(c=>c.state!=='value'||c.confirmed===false);}
export interface CellSourceOptions {
 field:string;value:string;cell:ValueCell;sources?:string[];method?:string;owners?:{label:string;id:string}[];
 membership?:'pass'|'unknown';confirmed?:boolean;show?:()=>void;technical:unknown;
}
/** Human explanation first; raw evidence is materialized only on explicit expansion. */
export function renderCellSource(host:HTMLElement,options:CellSourceOptions){
 host.replaceChildren();host.classList.add('cell-source');host.setAttribute('aria-label','Источник: '+options.field);
 if(options.cell.state==='value'){const value=node('p',options.value);value.className='cell-source-value';host.append(value);}
 const status=node('p',states[options.cell.state]+(options.confirmed===false?' · требуется подтверждение':''));status.dataset.sourceState=options.cell.state;host.append(status);
 if(options.cell.reason&&options.cell.reason!==states[options.cell.state])host.append(node('p',options.cell.reason));
 if(options.cell.state==='conflict'||options.cell.state==='mixed'){
  const values=[...new Set(options.cell.evidence.flatMap(e=>typeof e.value==='string'?[e.value===''?'пустая строка':e.value]:typeof e.value==='number'&&Number.isFinite(e.value)?[String(e.value)]:[]))];
  if(values.length)host.append(node('p','Прочитанные варианты (исходные значения): '+values.slice(0,8).join('; ')+(values.length>8?`; ещё ${values.length-8}`:'')));
 }
 if(options.membership==='unknown')host.append(node('p','Принадлежность строки этой таблице не подтверждена.'));
 if(options.method)host.append(node('p','Получено: '+options.method));
 const sources=[...new Set(options.sources??[])];if(sources.length)host.append(node('p','Файл: '+sources.slice(0,8).join('; ')+(sources.length>8?`; ещё ${sources.length-8}`:'')));
 const owners=[...new Map((options.owners??[]).map(o=>[o.label+'\0'+o.id,o])).values()];
 if(owners.length){
  const list=node('ul');for(const owner of owners.slice(0,12))list.append(node('li',`${owner.label}: ${owner.id}`));host.append(list);
  if(owners.length>12)host.append(node('p',`Ещё ${owners.length-12} источников в технических данных.`));
  const copy=node('button','Копировать ID источников');copy.type='button';copy.dataset.copy=owners.map(o=>o.id).join('\n');host.append(copy);
 }
 if(options.show){const show=node('button','Показать в модели');show.type='button';show.onclick=options.show;host.append(show);}
 const technical=node('details');technical.append(node('summary','Технические данные источника'));let rendered=false;
 technical.ontoggle=()=>{if(technical.open&&!rendered){technical.append(node('pre',JSON.stringify(options.technical,null,2)));rendered=true;}};host.append(technical);
}
