import {specificationCell} from './model-specification.ts';
import type {ModelPackage} from './model.ts';
import type {SpecDataset,SpecInput,SpecColumn,SpecDefinition} from './model-specification.ts';
import type {ValueCell} from './rvt-schedule.ts';
import {evaluateFilter} from './rvt-schedule-rules.ts';
import {elementCategory} from './element-category.ts';
import {effectiveParameter,nativeInstanceClasses} from './rvt-schedule.ts';
import {rvtCategoryNames} from './rvt-category-names.ts';
import {gostColumns,mappedFields,emptyGostSettings,validateGostSettings} from './gost-settings.ts';
import type {GostSettings,GostField,MappedField,GostBinding} from './gost-settings.ts';
export interface GostCell extends ValueCell {blank?:boolean;confirmed?:boolean}
export interface GostRow {number:number;keys:string[];scene_ids:string[];cells:Record<GostField,GostCell>}
export interface GostIssue {kind:'question'|'conflict'|'coverage';message:string;keys:string[];field?:GostField}
export interface GostReport {project_id:string;contract:'UvyazkaGostSpecification';version:1;definition:SpecDefinition;settings:GostSettings;source_metadata:Record<string,unknown>;rows:GostRow[];issues:GostIssue[];selection:{key:string;scene_id:string|null;state:'pass'|'excluded'|'unknown';reason:string}[];coverage:{read:number;eligible:number;included:number;excluded:number;unknown:number;positions:number};release_ready:boolean}
// Native physical owner classes plus an explicit resolved category establish an
// instance even when tessellation failed. A name or geometry fragment cannot.
export function physicalRow(row:SpecInput):boolean{
 if(row.element)return row.element.role==='element'&&row.element.semantic_kind!=='geometry_fragment'&&(row.element.hierarchy?.includes('IfcElement')??false);
 const category=effectiveParameter(row.native,row.type,'-1140363');
 return !!row.native&&nativeInstanceClasses.has(row.native.class_name)&&category.state==='value'&&!!rvtCategoryNames[String(category.value)]&&!['-2000045','-2000051'].includes(String(category.value));
}
export function rowCategory(row:SpecInput,model?:ModelPackage|null):string{const category=effectiveParameter(row.native,row.type,'-1140363');return row.element?(model?elementCategory(row.element,model).name:row.element.class):category.state==='value'?rvtCategoryNames[String(category.value)]??row.native?.class_name??'Не прочитана':row.native?.class_name??'Не прочитана';}
export function rowModel(row:SpecInput){return row.source_sha256;}
export function fieldStats(dataset:SpecDataset,column:SpecColumn){let filled=0;const examples:string[]=[];for(const row of dataset.rows){const c=specificationCell(dataset,row,column);if(c.state==='value'){filled++;const s=String(c.value);if(!examples.includes(s)&&examples.length<3)examples.push(s.slice(0,110));}}return {filled,total:dataset.rows.length,examples};}
const captions:Record<MappedField,string[]>={position:['ADSK_Позиция','Марка','Марка типа','Mark','Tag'],name:['ADSK_Наименование','Наименование','Наименование и техническая характеристика','Описание','Description'],type:['ADSK_Марка','Тип','Type','Type Name','Типоразмер'],code:['ADSK_Код изделия','Код продукции','Product Code','Article Number'],supplier:['ADSK_Завод-изготовитель','Поставщик','Изготовитель','Manufacturer','Supplier'],mass:['ADSK_Масса','Масса','Масса 1 ед., кг','Mass','Weight'],note:['ADSK_Примечание','Примечание','Комментарии','Comments']};
export function proposeGost(dataset:SpecDataset):GostSettings{
 const settings=emptyGostSettings();
 const effective=new Set(dataset.columns.filter(c=>c.kind==='rvt'&&c.scope==='effective').map(c=>JSON.stringify([c.source_sha256,c.parameter_id])));
 for(const field of mappedFields){const wanted=captions[field].map(s=>s.toLocaleLowerCase());const candidates=dataset.columns.filter(c=>c.kind!=='base'&&(c.kind!=='rvt'||c.scope==='effective'||!effective.has(JSON.stringify([c.source_sha256,c.parameter_id])))).filter(c=>{const caption=c.kind==='property'?c.path?.at(-1):c.label.split(' · ').filter(s=>!s.startsWith('#')).at(-1);return caption&&wanted.includes(caption.toLocaleLowerCase());});
  // Captions only propose. They never establish semantic equivalence.
  if(candidates.length===1)settings.bindings[field]={kind:'field',field_id:candidates[0].id,confirmed:false};
 }
 if(settings.bindings.name.kind==='unmapped')settings.bindings.name={kind:'field',field_id:'name',confirmed:false};
 settings.categories=[...new Set(dataset.rows.filter(physicalRow).map(r=>rowCategory(r,dataset.model)))].filter(c=>['Mechanical Equipment','Механическое оборудование','Оборудование','IfcFan','IfcPump','IfcUnitaryEquipment','IfcAirTerminalBox','IfcBoiler','IfcChiller','IfcCoil','IfcHumidifier'].includes(c));
 return settings;
}
function cell(dataset:SpecDataset,row:SpecInput,binding:GostBinding,field:MappedField):GostCell{
 if(binding.kind==='unmapped')return {state:'missing',reason:'Не назначен источник графы',evidence:[],confirmed:false};
 if(binding.kind==='blank')return {state:'value',value:'',blank:true,confirmed:binding.confirmed,reason:binding.reason,evidence:[{owner_id:row.key,path:['gost',field],value:'',storage_type:'String',location:{kind:'user_decision',reason:binding.reason}}]};
 if(binding.kind==='constant'){if(field==='mass'){const n=Number(binding.value.replace(',','.'));if(!binding.value.trim()||!Number.isFinite(n)||n<0)return {state:'unsupported',reason:'Недопустимая масса',evidence:[],confirmed:binding.confirmed};return {state:'value',value:n,unit:'kg',storage_type:'Double',confirmed:binding.confirmed,evidence:[{owner_id:row.key,path:['gost',field],value:n,storage_type:'Double',location:{kind:'user_value',unit:'kg'}}]};}return {state:'value',value:binding.value,storage_type:'String',confirmed:binding.confirmed,evidence:[{owner_id:row.key,path:['gost',field],value:binding.value,storage_type:'String',location:{kind:'user_value'}}]};}
 const column=dataset.columns.find(c=>c.id===binding.field_id);const c=column?specificationCell(dataset,row,column):{state:'missing' as const,reason:'Параметр отсутствует в этой ревизии',evidence:[]};
 if(field==='mass'&&c.state==='value'&&(typeof c.value!=='number'||c.value<0||c.unit!=='kg'))return {...c,state:'unsupported',reason:'Для графы массы нужно числовое значение с подтверждённой единицей kg',confirmed:binding.confirmed};
 return {...c,confirmed:binding.confirmed};
}
export function buildGost(dataset:SpecDataset,definition:SpecDefinition,scopeIds?:string[],projectId:string=dataset.model?.project_id??''):GostReport{
 if(!definition.gost)throw Error('Не выбран шаблон ГОСТ');
 const settings=validateGostSettings(definition.gost);
 if(definition.model_id!==(dataset.model?.model_id??null)||JSON.stringify([...definition.source_hashes].sort())!==JSON.stringify(dataset.source_hashes))throw Error('Источники или ревизия изменились');
 const issues:GostIssue[]=[],rows:GostRow[]=[],selection:GostReport['selection']=[],scope=definition.scope==='all'?null:new Set(scopeIds??definition.scope_ids??[]);
 let eligible=0,included=0,excluded=0,unknown=0;
 if(!settings.quantity_confirmed)issues.push({kind:'question',message:'Подтвердите состав выборки и подсчёт экземпляров в штуках',keys:[]});
 if(!settings.categories.length)issues.push({kind:'question',message:'Выберите категории оборудования. Пустой выбор не означает все категории',keys:[]});
 for(const field of mappedFields){const b=settings.bindings[field];if(b.kind==='unmapped'||!b.confirmed)issues.push({kind:'question',field,message:`${gostColumns.find(c=>c[0]===field)![1]}: ${b.kind==='unmapped'?'не назначен источник или основание пустой графы':'привязка предложена, но не подтверждена'}`,keys:[]});}
 for(const k of ['designation','project','building','title','organization','developer','checker','normcontrol'] as const)if(!settings.drawing[k].trim())issues.push({kind:'question',message:'Не заполнен реквизит листа: '+({designation:'обозначение',project:'объект',building:'здание',title:'название документа',organization:'организация',developer:'разработал',checker:'проверил',normcontrol:'нормоконтроль'}[k]),keys:[]});
 if(settings.drawing.stage!=='Р')issues.push({kind:'question',message:'Для спецификации рабочей документации проверьте стадию «Р»',keys:[]});
 const seenIds=new Map<string,string>();
 for(const row of dataset.rows){
  let reason='';if(!physicalRow(row))reason='Запись не подтверждена как физический элемент';else {eligible++;if(scope&&(!row.scene_id||!scope.has(row.scene_id)))reason='Вне выбранной области';else if(!settings.categories.includes(rowCategory(row,dataset.model)))reason='Категория не выбрана';else if(settings.models.length&&!settings.models.includes(rowModel(row)))reason='Исходная модель не выбрана';else if(settings.levels.length&&!settings.levels.includes(row.element?.storey_id??''))reason='Уровень не выбран';}
  if(reason){excluded++;selection.push({key:row.key,scene_id:row.scene_id,state:'excluded',reason});continue;}
  if(settings.system){const member=dataset.model?.systems?.find(s=>s.id===settings.system)?.member_ids;if(!member){unknown++;selection.push({key:row.key,scene_id:row.scene_id,state:'unknown',reason:'Членство в системе не прочитано'});continue;}if(!row.scene_id||!member.includes(row.scene_id)){excluded++;selection.push({key:row.key,scene_id:row.scene_id,state:'excluded',reason:'Не состоит в выбранной прочитанной системе'});continue;}}
  const decisions=definition.filters.map(f=>{const column=dataset.columns.find(c=>c.id===f.field_id);if(!column)return {state:'unknown',reason:'Поле фильтра отсутствует'};const c=specificationCell(dataset,row,column);if(f.operator!=='has_value'&&typeof c.value==='number'&&c.storage_type!=='ElementId'&&(!c.unit||c.unit==='native'))return {state:'unknown',reason:'Единицы порога не подтверждены'};return evaluateFilter(f,c);});
  if(decisions.some(d=>d.state==='fail')){excluded++;selection.push({key:row.key,scene_id:row.scene_id,state:'excluded',reason:'Не прошёл дополнительные условия'});continue;}
  if(decisions.some(d=>d.state==='unknown')){unknown++;selection.push({key:row.key,scene_id:row.scene_id,state:'unknown',reason:'Результат дополнительного отбора не подтверждён'});continue;}
  included++;selection.push({key:row.key,scene_id:row.scene_id,state:'pass',reason:'Выбранный состав'});
  const values=Object.fromEntries(mappedFields.map(field=>[field,cell(dataset,row,settings.bindings[field],field)])) as Record<GostField,GostCell>;
  const evidence={owner_id:row.key,path:['gost','quantity'],value:1,storage_type:'Integer',location:{kind:'counted_instance',source_sha256:row.source_sha256,scene_id:row.scene_id,revit_id:specificationCell(dataset,row,dataset.columns.find(c=>c.id==='revit')!),ifc_global_id:row.element?.global_id,native_source:row.native?.source}};
  values.unit={state:'value',value:'шт.',confirmed:settings.quantity_confirmed,evidence:[{...evidence,path:['gost','unit'],value:'шт.'}]};values.quantity={state:'value',value:1,unit:'шт.',storage_type:'Integer',confirmed:settings.quantity_confirmed,evidence:[evidence]};
  for(const field of mappedFields){const c=values[field];if(settings.bindings[field].kind!=='unmapped'&&(c.state!=='value'||field==='name'&&!String(c.value??'').trim()))issues.push({kind:c.state==='conflict'?'conflict':'question',field,message:`${row.name}: ${gostColumns.find(x=>x[0]===field)![1]} — ${c.reason??'значение не прочитано'}`,keys:[row.key]});}
  const stable=row.element?.global_id;if(stable){const old=seenIds.get(stable);if(old)issues.push({kind:'conflict',message:'Повтор IFC GlobalId в выборке: возможен двойной учёт',keys:[old,row.key]});else seenIds.set(stable,row.key);}
  rows.push({number:0,keys:[row.key],scene_ids:row.scene_id?[row.scene_id]:[],cells:values});
 }
 if(unknown)issues.push({kind:'question',message:`Не подтверждён отбор ${unknown} записей; они не включены в количество`,keys:selection.filter(s=>s.state==='unknown').map(s=>s.key)});
 if(!rows.length)issues.push({kind:'question',message:'В выбранном составе нет подтверждённых экземпляров оборудования',keys:[]});
 let output=rows;
 if(settings.group_identical){const groups=new Map<string,GostRow>();for(const row of rows){const fields=gostColumns.filter(c=>c[0]!=='quantity').map(c=>row.cells[c[0]]);const safe=fields.every(c=>c.state==='value'&&c.confirmed);const key=safe?JSON.stringify(fields.map(c=>[c.value,c.unit,c.blank])):row.keys[0];const found=groups.get(key);if(found){found.keys.push(...row.keys);found.scene_ids.push(...row.scene_ids);found.cells.quantity.value=Number(found.cells.quantity.value)+1;for(const [field]of gostColumns)found.cells[field].evidence.push(...row.cells[field].evidence);}else groups.set(key,structuredClone(row));}output=[...groups.values()];}
 output.forEach((row,index)=>row.number=index+1);
 // Source coverage stays visible even when every selected row is filled.
 issues.push({kind:'coverage',message:'Охват извлечения RVT/IFC частичный. Ведомость относится к прочитанным выбранным экземплярам; полнота проекта не подтверждена.',keys:[]});
 return {project_id:projectId,contract:'UvyazkaGostSpecification',version:1,definition:{...structuredClone(definition),...(scope?{scope_ids:[...scope]}:{})},settings,source_metadata:dataset.source_metadata,rows:output,issues,selection,coverage:{read:dataset.rows.length,eligible,included,excluded,unknown,positions:output.length},release_ready:!issues.some(i=>i.kind!=='coverage')};
}
