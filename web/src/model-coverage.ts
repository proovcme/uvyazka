import type {ModelPackage} from './model';
import {onlyNavisSources} from './navis-format.ts';
export type CoverageItem={key:string;label:string;status:'read'|'partial'|'unknown'|'unsupported';detail:string};
export function modelCoverage(model:ModelPackage):CoverageItem[]{
 const navis=onlyNavisSources(model),n=model.nwd,s=model.statistics;
 const geometryPartial=s.geometry_errors>0||!!n?.source_models.some(source=>!source.geometry_complete);
 return [
  {key:'geometry',label:'Геометрия',status:s.meshes>0?geometryPartial?'partial':'read':'unknown',detail:s.meshes>0?`${s.meshes} сеток${s.geometry_errors>0?`; без геометрии: ${s.geometry_errors}`:''}. ${geometryPartial?'Есть пропуски или вопросы к исходным данным.':'Прочитанный набор; полнота исходного проекта не подтверждена.'}`:'Пригодная геометрия не получена.'},
  {key:'tree',label:'Дерево',status:navis?n?.logical_nodes?n.source_models.some(source=>source.metadata_status!=='decoded_logical_subset')?'partial':'read':'unknown':model.elements.length?'read':'unknown',detail:navis?`${n?.logical_nodes??0} прочитанных узлов. Это не количество оборудования.`:'Структура прочитанных элементов.'},
  {key:'properties',label:'Свойства',status:model.elements.some(e=>Object.keys(e.property_sets??{}).length)?navis?'partial':'read':'unknown',detail:navis?'Доступны прочитанные поля. Полнота исходных свойств не подтверждена.':'Доступны извлечённые поля; отсутствие значения не означает ноль.'},
  {key:'systems',label:'Системы и подключения',status:model.systems?.length?'partial':navis?'unsupported':'unknown',detail:model.systems?.length?'Прочитаны системы; физическая связность требует отдельной проверки.':navis?'Читатель Navisworks пока не восстанавливает инженерные системы.':'Системы не прочитаны; их отсутствие не установлено.'},
  {key:'views',label:'Исходные виды',status:navis?'unsupported':'unknown',detail:navis?'Сохранённые виды Navisworks пока не импортируются.':'Доступность графики проверяется отдельно в каталоге документа.'},
 ];
}
export function levelSummary(model:ModelPackage){return model.storeys.length?String(model.storeys.length):'Не прочитаны';}
export function renderCoverage(host:HTMLElement,model:ModelPackage){
 renderCoverageItems(host,modelCoverage(model));
}
export function renderCoverageItems(host:HTMLElement,items:CoverageItem[]){
 host.replaceChildren();const list=document.createElement('dl');list.className='model-coverage';
 const labels={read:'Прочитано',partial:'Частично',unknown:'Не установлено',unsupported:'Пока не поддерживается'};
 for(const item of items){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=item.label;dd.textContent=labels[item.status];dd.dataset.coverage=item.status;dd.title=item.detail;const detail=document.createElement('small');detail.textContent=item.detail;dd.append(detail);list.append(dt,dd);}host.append(list);
}
