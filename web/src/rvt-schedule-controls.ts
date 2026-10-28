import {previewValue} from './rvt-schedule';
import type {reconstructSchedule,ScheduleOptions} from './rvt-schedule';
import type {ReviewFilter,FilterOperator} from './rvt-schedule-rules';
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};

export function scheduleControls(host:HTMLElement,report:ReturnType<typeof reconstructSchedule>,settings:ScheduleOptions,rerender:()=>void){
 const label=node('label','Группировка '),group=node('select');group.setAttribute('aria-label','Группировка ведомости');
 for(const [value,text] of [['schedule','По ключам из RVT (требует сверки)'],['instances','Каждый экземпляр'],['type','По ID типа']]){const option=node('option',text);option.value=value;group.append(option);}group.value=settings.grouping!;group.onchange=()=>{settings.grouping=group.value as ScheduleOptions['grouping'];rerender();};label.append(group);host.append(label);
 const controls=node('details');controls.id='rvt-review-rules';controls.append(node('summary',`Фильтры сверки и суммы (${settings.filters!.length})`));
 controls.append(node('p','Это ваши правила сверки, отдельно от фильтров RVT. Условия соединены И. Текст сравнивается с учётом регистра. Для ширины и высоты можно вводить миллиметры; правило сохраняет порог в исходных футах. Неизвестные значения не отбрасываются.'));
 const field=node('select');field.setAttribute('aria-label','Поле фильтра');
 for(const c of report.all_columns){if(c.id===null)continue;const option=node('option',`${c.properties.m_columnHeading??'Поле'} · ID ${c.id}${c.properties.m_hidden?' · скрытое':''}`);option.value=c.id;field.append(option);}controls.append(field);
 const operator=node('select');operator.setAttribute('aria-label','Условие фильтра');
 for(const [value,text] of [['equal','Равно'],['not_equal','Не равно'],['greater','Больше'],['greater_equal','Не меньше'],['less','Меньше'],['less_equal','Не больше'],['contains','Содержит'],['not_contains','Не содержит'],['begins','Начинается с'],['ends','Заканчивается на'],['has_value','Значение прочитано']]){const option=node('option',text);option.value=value;operator.append(option);}controls.append(operator);
 const type=node('select');type.setAttribute('aria-label','Тип порога');
 for(const [value,text] of [['text','Текст'],['number','Число / ID (без единиц)'],['mm','Миллиметры → исходные футы'],['ft','Число в футах'],['native','Число в исходных единицах']]){const option=node('option',text);option.value=value;type.append(option);}controls.append(type);
 const threshold=node('input');threshold.type='text';threshold.placeholder='Порог';threshold.setAttribute('aria-label','Значение порога');controls.append(threshold);
 const error=node('p');error.setAttribute('role','status');controls.append(error);
 const add=node('button','Добавить фильтр');add.disabled=!field.options.length;add.onclick=()=>{
  const f:ReviewFilter={field_id:field.value,operator:operator.value as FilterOperator};
  if(f.operator!=='has_value'){
   if(type.value==='text')f.value=threshold.value;
   else {const raw=threshold.value.trim().replace(',','.');if(!raw||!Number.isFinite(Number(raw))){error.textContent='Введите конечное число; пустое значение не равно нулю.';return;}f.value=type.value==='mm'?Number(raw)/304.8:Number(raw);if(type.value!=='number')f.unit=type.value==='mm'?'ft':type.value;}
  }
  settings.filters!.push(f);rerender();(host.querySelector('#rvt-review-rules') as HTMLDetailsElement).open=true;
 };controls.append(add);
 settings.filters!.forEach((f,i)=>{const line=node('p',`Поле ${f.field_id}: ${f.operator} ${f.value??''} ${f.unit??''} `),remove=node('button',`Убрать фильтр ${i+1}`);remove.onclick=()=>{settings.filters!.splice(i,1);rerender();};line.append(remove);controls.append(line);});
 const sum=node('button','Добавить контрольную сумму выбранного поля');sum.disabled=!field.options.length;sum.onclick=()=>{if(!settings.sum_fields!.includes(field.value))settings.sum_fields!.push(field.value);rerender();};controls.append(sum);host.append(controls);
 if(report.totals.length){const summary=node('details');summary.append(node('summary','Контрольные суммы прошедших условия экземпляров'));summary.append(node('p','Суммы считаются до группировки. Исключённые и неопределённые строки не входят; это не итоги Revit.'));
  for(const total of report.totals){const line=node('p',`Поле ${total.field_id}: ${previewValue(total.cell)} · ${total.instance_count} экз. `),source=node('details');source.append(node('summary','Источники суммы'),node('pre',JSON.stringify(total,null,2)));const remove=node('button',`Убрать сумму ${total.field_id}`);remove.onclick=()=>{settings.sum_fields=settings.sum_fields!.filter(id=>id!==total.field_id);rerender();};line.append(remove);summary.append(line,source);}host.append(summary);
 }
 const audit=node('details');audit.id='rvt-selection-audit';audit.append(node('summary','Журнал отбора и исходные правила'));const auditText=node('pre');audit.append(auditText);audit.ontoggle=()=>{if(audit.open)auditText.textContent=JSON.stringify({rules:report.rule_audit,selection:report.selection.slice(0,100),display_limit:100,total:report.selection.length},null,2);};host.append(audit);
}
