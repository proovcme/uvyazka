/** Presentation only: original records, IDs, diagnostics and exports stay intact. */
import '../../src/uvyazka/ui/language.js';
export const userMessage=(globalThis as unknown as {UvyazkaLanguage:{userMessage:(value:unknown,fallback?:string)=>string}}).UvyazkaLanguage.userMessage;
const operatorLabels:Record<string,string>={contains:'содержит',equal:'равно',not_equal:'не равно',greater:'больше',greater_equal:'не меньше',less:'меньше',less_equal:'не больше',has_value:'значение прочитано',not_contains:'не содержит',begins:'начинается с',ends:'заканчивается на'};
export const filterOperatorLabel=(operator:string)=>operatorLabels[operator]??'условие не поддержано';
export function sourceFormatLabel(source:{schema?:string;format?:string;rvt_read_mode?:string}){
 if(source.schema==='DocumentSpatialModel')return 'Условная модель по документации';
 if(source.schema==='SyntheticDemo')return 'Синтетическая учебная модель';
 if(source.format==='federation')return 'Сводная модель';
 if(source.rvt_read_mode==='direct')return 'RVT · экспериментальное чтение';
 if(['rvt','ifc','nwd','nwc','dwg','dxf'].includes(source.format??''))return source.format!.toUpperCase();
 if(/^IFC(?:2X3|4(?:X3(?:_ADD\d+)?)?)$/.test(source.schema??''))return source.schema!;
 return 'Модель из файла';
}
export function addDiagnostics(host:HTMLElement,value:unknown,label='Диагностика'){
 const details=document.createElement('details'),summary=document.createElement('summary');details.className='ui-diagnostics';summary.textContent=label;details.append(summary);let loaded=false;
 details.addEventListener('toggle',()=>{if(!details.open||loaded)return;loaded=true;const pre=document.createElement('pre'),data=typeof value==='function'?value():value;pre.textContent=typeof data==='string'?data:JSON.stringify(data,null,2);details.append(pre);});host.append(details);return details;
}
export const displayClass=(globalThis as unknown as {UvyazkaLanguage:{displayClass:(value:string)=>string}}).UvyazkaLanguage.displayClass;
export function displayElementName(name:string,kind:string,id?:string|null){return /^(?:lcatfconsumer_\w+|FamilyInstance(?: · Revit \d+)?|Rbs\w+(?: · Revit \d+)?|Ifc[A-Z]\w*)$/.test(name)?displayClass(kind)+(id?' · Revit '+id:''):name;}
export function progressStage(stage:string){if(/сигнатур|SHA|хеш|целост/i.test(stage))return 'Проверка файла';if(/геомет|отображ|сцен/i.test(stage))return 'Подготовка 3D-модели';if(/кеш|сохран|баз/i.test(stage))return 'Сохранение результата';if(/параметр|данн|каталог|таблиц/i.test(stage))return 'Чтение данных модели';if(/WASM|движ|модул|worker/i.test(stage))return 'Подготовка к открытию';return userMessage(stage,'Обработка файла');}
export function progressMessage(stage:string,message:string){return /WASM|worker|декодер|граф|слотов|поток|SHA-256|сеток|фрагмент|владельц|объектов графа|\bm_\w+/i.test(message)?progressStage(stage)+'…':userMessage(message,progressStage(stage)+'…');}
export const technicalProperty=(name:string)=>/^(?:m_|serialized_|pointer_|record_offset|body_sha256|file_sha256|schema_sha256|Параметр\s+-?\d+|Native field|Graph)/i.test(name)||/^(?:BodySource|ProfileResolved|LevelBindResolved|LevelBindSource|SourceStream|RevitClass|StoreyBindSource)$/.test(name);
export const technicalPropertyGroup=(name:string)=>/^(?:NWD fragment|Источник RVT|Служебные|RVT Identity|RVT saved|Saved graphics)/i.test(name);
