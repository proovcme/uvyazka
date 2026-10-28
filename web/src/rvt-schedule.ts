import {nativeFilter,evaluateNativeFilter} from './rvt-native-filter.ts';
import {identifier,schedule,csvCell} from './rvt-document.ts';
import type {NativeRecord,RvtDocument} from './rvt-document.ts';
import {compareCells,evaluateFilter,sumCells} from './rvt-schedule-rules.ts';
import type {ReviewFilter,FilterDecision} from './rvt-schedule-rules.ts';

export interface ParameterRecord {
 identity:{element_id:number|string};class_name:string;status:string;source:unknown;
 workset?:{status:string;partition_id:number;name:string;source:unknown};root_fields?:Record<string,any>;saved_metadata?:Record<string,any>|null;metadata_diagnostic?:string;
}
export interface ScheduleData {source_sha256:string;status:string;error?:string;scope:string[];records:ParameterRecord[];summary?:any;clipped_records?:number;workset_error?:string|null}
export interface Evidence {owner_id:string;path:(string|number)[];value:unknown;storage_type:string;location:unknown;rule?:string}
export interface ValueCell {state:'value'|'missing'|'conflict'|'unsupported'|'mixed';value?:string|number;storage_type?:string;unit?:string;reason?:string;evidence:Evidence[]}
export interface PreviewRow {element_ids:string[];type_id:string|null;cells:ValueCell[];membership:'pass'|'unknown'}
export interface ScheduleOptions {grouping?:'instances'|'type'|'schedule';filters?:ReviewFilter[];sum_fields?:string[]}
export interface SelectionDecision {element_id:string;state:'pass'|'fail'|'unknown';filters:FilterDecision[];native_filters_unresolved:boolean;native_filters?:FilterDecision[]}
// Narrow, explicit fallback for the same built-in IDs documented by the pinned
// rvt-rs partition_type_parameters.rs (RE-77/RE-93). Never choose a nonzero slot
// or match a caption. Kept distinct from file-owned parameter definitions.
const builtinSlots:Record<string,{storage:string;unit?:string}>={
 '-1001301':{storage:'Double',unit:'ft'},'-1001300':{storage:'Double',unit:'ft'},
 '-1001405':{storage:'String'},'-1010103':{storage:'String'},'-1001206':{storage:'String'}
};
const missing=(reason:string):ValueCell=>({state:'missing',reason,evidence:[]});
export function parameter(owner:ParameterRecord|undefined,id:string):ValueCell {
 if(id==='-1002053'&&owner?.workset?.status==='decoded'&&Number.isSafeInteger(owner.workset.partition_id))return {state:'value',value:owner.workset.partition_id,storage_type:'Integer',evidence:[{owner_id:String(owner.identity.element_id),path:['workset','partition_id'],value:owner.workset.partition_id,storage_type:'Integer',location:owner.workset.source,rule:'native_index_partition_id_to_saved_user_partition'}]};
 if(!owner?.saved_metadata)return missing('Параметры владельца не прочитаны');
 const m=owner.saved_metadata,evidence:Evidence[]=[];
 const add=(value:unknown,storage:string,path:(string|number)[],rule?:string)=>evidence.push({owner_id:String(owner.identity.element_id),value,storage_type:storage,path:['saved_metadata',...path],location:owner.source,rule});
 (m.parameter_sets??[]).forEach((set:any,si:number)=>(set.parameters??[]).forEach((p:any,pi:number)=>{if(String(p.serialized_parameter_id)===id)add(p.raw_value,p.storage_type,['parameter_sets',si,'parameters',pi]);}));
 (m.raw_field_parameters??[]).forEach((p:any,i:number)=>{if(String(p.parameter_id)===id)add(p.raw_value,p.storage_type,['raw_field_parameters',i],p.projection_rule);});
 (m.resolved_family_parameters??[]).forEach((p:any,i:number)=>{if(String(p.parameter_id)===id&&p.has_value===true)add(p.raw_value,p.storage_type,['resolved_family_parameters',i]);});
 const slots=(m.family_parameter_slots??[]).map((p:any,i:number)=>({p,i})).filter(({p}:any)=>String(p.parameter_id)===id);
 const profile=builtinSlots[id];
 if(profile)for(const {p,i} of slots){const field=profile.storage==='Double'?'double_slot':'string_slot';add(p[field],profile.storage,['family_parameter_slots',i,field],'pinned-rvt-rs/partition_type_parameters.rs:RE-77/RE-93');}
 if(!evidence.length)return {state:slots.length?'unsupported':'missing',reason:slots.length?'Тип хранения слота не подтверждён':'Значение не прочитано',evidence:slots.map(({p,i}:any)=>({owner_id:String(owner.identity.element_id),path:['saved_metadata','family_parameter_slots',i],value:p,storage_type:'unresolved',location:owner.source}))};
 if((m.declared_custom_parameters??[]).some((p:any)=>String(p.parameter_id)===id&&p.has_value===false))return {state:'conflict',reason:'Значение противоречит сохранённому признаку HasValue',evidence};
 const valid=evidence.every(e=>e.storage_type==='String'?typeof e.value==='string':['Double','Integer','ElementId'].includes(e.storage_type)&&typeof e.value==='number'&&Number.isFinite(e.value)&&(e.storage_type==='Double'||Number.isSafeInteger(e.value)));
 if(!valid)return {state:'unsupported',reason:'Неподдержанное представление значения',evidence};
 if(new Set(evidence.map(e=>JSON.stringify([e.storage_type,e.value]))).size>1)return {state:'conflict',reason:'Несколько разных значений одного параметра',evidence};
 return {state:'value',value:evidence[0].value as string|number,storage_type:evidence[0].storage_type,unit:profile?.unit??(evidence[0].storage_type==='Double'?'native':undefined),evidence};
}
export const nativeInstanceClasses=new Set(['FamilyInstance','RbsPipeCurve','RbsDuctCurve','RbsFlexPipeCurve','RbsFlexDuctCurve','CableTray','RbsConduitCurve','RbsPipeInsulation','RbsDuctInsulation','RbsDuctLining']);
export function nativeTypeId(owner:ParameterRecord):string|null{return identifier(owner.saved_metadata?.root_references?.m_masterSymbolId??owner.root_fields?.m_masterSymbolId??owner.root_fields?.m_idType);}
export function effectiveParameter(owner:ParameterRecord|undefined,type:ParameterRecord|undefined,id:string):ValueCell{
 const cell=parameter(owner,id);if(cell.state!=='missing')return cell;
 const inherited=parameter(type,id);if(inherited.state!=='value')return cell;
 return {...inherited,evidence:inherited.evidence.map(e=>({...e,rule:[e.rule,'explicit_instance_type_reference_fallback'].filter(Boolean).join(';')}))};
}
export function parameterDefinitions(owner:ParameterRecord,data?:ScheduleData):any[]{
 const m=owner.saved_metadata;if(!m)return [];
 return [...(m.parameter_definitions??[]),...(m.builtin_parameter_definitions??[]),...(m.parameter_definitions_ids??[]).flatMap((id:any)=>data?.summary?.parameter_definitions?.[String(id)]??[])];
}
function mergeCells(cells:ValueCell[]):ValueCell {
 if(cells.length===1)return cells[0];
 const evidence=[...new Map(cells.flatMap(c=>c.evidence).map(e=>[JSON.stringify(e),e])).values()];
 if(cells.some(c=>c.state==='conflict'))return {state:'conflict',reason:'Конфликт в одном из экземпляров',evidence};
 if(cells.some(c=>c.state==='unsupported'))return {state:'unsupported',reason:'Тип или правило одного из значений не поддержаны',evidence};
 if(cells.some(c=>c.state==='missing'))return {state:'missing',reason:'Не все экземпляры имеют прочитанное значение',evidence};
 if(new Set(cells.map(c=>JSON.stringify([c.state,c.storage_type,c.value,c.unit]))).size>1)return {state:'mixed',reason:'Разные значения у экземпляров группы',evidence};
 return {...cells[0],evidence};
}
export function reconstructSchedule(record:NativeRecord,document:RvtDocument,options:boolean|ScheduleOptions={grouping:'schedule'}){
 const settings:ScheduleOptions=typeof options==='boolean'?{grouping:options?'type':'instances'}:options;
 const grouping=settings.grouping??'schedule',groupByType=grouping==='type';
 const definition=schedule(record),s=definition.schema,data=document.schedule_data;
 const allColumns=definition.columns,visible=allColumns.flatMap((c,i)=>c.properties.m_hidden===true?[]:[i]);
 const columns=visible.map(i=>allColumns[i]);
 const issues:string[]=['Сверочная выборка прочитанных экземпляров и инженерных кривых. Стадии, варианты, область видимости и связи не применены. Статус отбора относится только к проверенным условиям, не ко всей видимости Revit.'];
 const rows:PreviewRow[]=[],selection:SelectionDecision[]=[];
 const totals:{field_id:string;cell:ValueCell;scope:string;instance_count:number}[]=[];
 let unresolved=0;
 const nativeFilterCount=Array.isArray(s?.m_filterArr)?s.m_filterArr.length:null;
 const savedFilters=definition.rules.filter(r=>r.field==='m_filterArr').map(r=>nativeFilter(r.properties));
 const nativeFiltersUnresolved=nativeFilterCount===null||savedFilters.length!==nativeFilterCount||savedFilters.some(r=>!r);
 const sortRules=definition.rules.filter(r=>r.field==='m_sortFieldArr');
 const fieldIndex=(id:string|null)=>id===null?-1:allColumns.filter(c=>c.id===id).length===1?allColumns.findIndex(c=>c.id===id):-1;
 const sortKeys=sortRules.map(r=>{const p=r.properties as Record<string,any>;return {index:fieldIndex(identifier(p.m_fieldId)),direction:p.m_sortOrder===0?1 as const:p.m_sortOrder===1?-1 as const:null,path:r.path,properties:p};});
 const sortComplete=Array.isArray(s?.m_sortFieldArr)&&sortKeys.length===s.m_sortFieldArr.length&&sortKeys.every(k=>k.index>=0&&k.direction!==null);
 const ruleAudit={profile:'uvyazka-schedule-review-v1',native_filters:{state:nativeFiltersUnresolved?'unsupported':nativeFilterCount?'interpreted_requires_review':'none',count:nativeFilterCount,rules:definition.rules.filter(r=>r.field==='m_filterArr')},sorting:{state:sortComplete?'interpreted_requires_review':'unsupported',keys:sortKeys},grouping,review_filters:settings.filters??[],sum_fields:settings.sum_fields??[]};
 const result=()=>({status:'partial' as const,rows,columns,all_columns:allColumns,issues,selection,totals,rule_audit:ruleAudit,unresolved_instances:unresolved,source:document.source,schedule_id:record.identity.element_id,category_id:identifier(s?.m_categoryId),group_by_type:groupByType,instance_count:rows.reduce((n,r)=>n+r.element_ids.length,0),passed_instances:selection.filter(d=>d.state==='pass').length,unknown_instances:selection.filter(d=>d.state==='unknown').length,excluded_instances:selection.filter(d=>d.state==='fail').length});
 if(!data){issues.push('Параметры элементов пока не прочитаны.');return result();}
 if(!document.source?.sha256||data.source_sha256!==document.source.sha256){issues.push('SHA-256 параметров не совпадает с исходным RVT.');return result();}
 if(!s){issues.push('Определение спецификации не прочитано.');return result();}
 const categoryId=identifier(s.m_categoryId);
 if(!categoryId){issues.push('Категория не определена; выборка не построена.');return result();}
 if(s.m_bMaterialSchedule||s.m_bRefTable||s.m_isEmbedded){issues.push('Материальная, ключевая или вложенная спецификация не поддерживается.');return result();}
 if(nativeFiltersUnresolved)issues.push('Фильтры RVT не расшифрованы: отбор кандидатов имеет статус «Неизвестно». Явные фильтры сверки не заменяют исходные фильтры.');
 if(nativeFilterCount&&!nativeFiltersUnresolved)issues.push('Применён поддержанный набор сохранённых фильтров RVT. Это профиль чтения Увязки; стадии, варианты и видимость Revit по-прежнему требуют проверки.');
 if(sortKeys.length)issues.push('Ключи сортировки и группировки прочитаны из RVT. Профиль Увязки трактует порядок 0/1 как возрастание/убывание; точность относительно Revit требует сверки. Текст сортируется с учётом регистра, ElementId не упорядочиваются.');
 if(!sortComplete)issues.push('Не все ключи сортировки разрешены: сортировка и объединение по правилам RVT отключены.');
 if(grouping==='schedule'&&typeof s.m_bInstanceSchedule!=='boolean')issues.push('Режим объединения исходной таблицы неизвестен: экземпляры оставлены отдельно.');
 if(sortKeys.some(k=>k.properties.m_groupingFlags))issues.push('Заголовки, подытоги и разделители групп Revit не воспроизводятся.');
 if(data.workset_error)issues.push('Рабочие наборы не прочитаны: '+data.workset_error);
 if(data.status==='partial'||data.error)issues.push('Нативное извлечение параметров неполное'+(data.error?': '+data.error:'.'));
 if(definition.issues.length)issues.push(...definition.issues);
 const index=new Map<string,ParameterRecord[]>();
 for(const r of data.records){const id=identifier(r.identity.element_id);if(id!==null)index.set(id,[...(index.get(id)??[]),r]);}
 const unique=(id:string|null)=>{const rs=id===null?undefined:index.get(id);return rs?.length===1?rs[0]:undefined;};
 const candidates:PreviewRow[]=[];
 for(const r of data.records){
  if(!nativeInstanceClasses.has(r.class_name))continue;
  const id=identifier(r.identity.element_id);if(id===null||index.get(id)?.length!==1){unresolved++;continue;}
  const cat=parameter(r,'-1140363');if(categoryId!=='-1'&&cat.state!=='value'){unresolved++;continue;}if(categoryId!=='-1'&&String(cat.value)!==categoryId)continue;
  const typeId=nativeTypeId(r),typeCandidate=unique(typeId),type=typeCandidate&&!nativeInstanceClasses.has(typeCandidate.class_name)?typeCandidate:undefined;
  const cells=allColumns.map(c=>{
   const f=c.properties,pid=identifier(f.m_paramElemId);
   if(f.m_pExpression?.pointer_token!==0&&f.m_pExpression?.pointer_token!==undefined||f.m_oCustomFieldData?.pointer_token||f.m_combineParameters?.length||identifier(f.m_percentageOfId)!==null&&identifier(f.m_percentageOfId)!=='-1')return {state:'unsupported' as const,reason:'Формула, процент, объединённое или пользовательское поле не вычисляется',evidence:[]};
   if(f.m_sourceType===2&&pid==='-1152353')return {state:'value' as const,value:1,storage_type:'Integer',evidence:[{owner_id:id,path:['identity','element_id'],value:1,storage_type:'Integer',location:r.source,rule:'one_per_observed_unique_family_instance'}]};
   if(!pid||![0,1].includes(f.m_sourceType))return {state:'unsupported' as const,reason:'Источник поля не поддержан',evidence:[]};
   if(pid==='-1002053'&&r.workset?.status==='decoded')return {state:'value' as const,value:r.workset.name,storage_type:'String',evidence:[{owner_id:id,path:['workset','name'],value:r.workset.name,storage_type:'String',location:r.workset.source,rule:'saved_user_partition_display_name'}]};
   return f.m_sourceType===1?parameter(type,pid):effectiveParameter(r,type,pid);
  });
  const filters=(settings.filters??[]).map(f=>evaluateFilter(f,cells[fieldIndex(f.field_id)]));
  const nativeDecisions=savedFilters.flatMap(rule=>{if(!rule)return [];const i=fieldIndex(rule.filter.field_id),pid=identifier(allColumns[i]?.properties.m_paramElemId);return [evaluateNativeFilter(rule,pid==='-1002053'&&rule.storage==='Integer'?parameter(r,pid):cells[i])];});
  const decisions=[...filters,...nativeDecisions];
  const state=decisions.some(f=>f.state==='fail')?'fail':nativeFiltersUnresolved||decisions.some(f=>f.state==='unknown')?'unknown':'pass';
  selection.push({element_id:id,state,filters,native_filters:nativeDecisions,native_filters_unresolved:nativeFiltersUnresolved});
  if(state!=='fail')candidates.push({element_ids:[id],type_id:type?typeId:null,cells,membership:state});
 }
 if(sortComplete)candidates.sort((a,b)=>{for(const key of sortKeys){const cmp=compareCells(a.cells[key.index],b.cells[key.index],key.direction!);if(cmp)return cmp;}return 0;});
 const groupMap=new Map<string,PreviewRow[]>();
 for(const row of candidates){
  let key='instance:'+row.element_ids[0];
  if(groupByType&&row.type_id)key='type:'+row.type_id;
  if(grouping==='schedule'&&s.m_bInstanceSchedule===false&&sortComplete&&sortKeys.every(k=>row.cells[k.index]?.state==='value'))key='schedule:'+JSON.stringify(sortKeys.map(k=>{const c=row.cells[k.index];return [c.storage_type,c.unit,c.value];}));
  // Unknown membership and unknown grouping keys never merge into confirmed groups.
  key=row.membership+':'+key;
  const members=groupMap.get(key);if(members)members.push(row);else groupMap.set(key,[row]);
 }
 for(const group of groupMap.values())rows.push({element_ids:group.flatMap(r=>r.element_ids),type_id:group.every(r=>r.type_id===group[0].type_id)?group[0].type_id:null,membership:group[0].membership,cells:visible.map(i=>allColumns[i].properties.m_sourceType===2&&identifier(allColumns[i].properties.m_paramElemId)==='-1152353'&&group.every(r=>r.cells[i].state==='value')?{state:'value',value:group.length,storage_type:'Integer',evidence:group.flatMap(r=>r.cells[i].evidence)}:mergeCells(group.map(r=>r.cells[i])))});
 const passed=candidates.filter(r=>r.membership==='pass');
 for(const id of new Set(settings.sum_fields??[])){const i=fieldIndex(id);totals.push({field_id:id,cell:i<0?{state:'unsupported',reason:'Поле суммы не разрешено.',evidence:[]}:sumCells(passed.map(r=>r.cells[i])),scope:'passed_review_filters_only_before_grouping',instance_count:passed.length});}
 if(selection.some(d=>d.state==='unknown'))issues.push('Неопределённые строки показаны отдельно и не включены в контрольные суммы. Причина отбора каждого элемента сохранена в JSON.');
 if(unresolved)issues.push(`${unresolved} записей экземпляров с неизвестной категорией или неоднозначным ID исключены; полнота не подтверждена.`);
 if(!rows.length)issues.push('В показанной выборке нет строк. Это не нулевое количество в проекте.');
 return result();
}
export function previewValue(cell:ValueCell):string {
 if(cell.state!=='value')return ({missing:'Не прочитано',conflict:'Конфликт',unsupported:'Не поддержано',mixed:'Разные значения'})[cell.state];
 if(cell.value==='')return 'Пустая строка';
 if(cell.unit==='ft'&&typeof cell.value==='number')return `${Number((cell.value*304.8).toFixed(6)).toLocaleString('ru-RU')} мм`;
 return cell.storage_type==='ElementId'?`ID ${cell.value}`:`${cell.value}${cell.unit==='ft'?' ft':cell.unit==='native'?' (исх. ед.)':''}`;
}
export function previewCsv(preview:ReturnType<typeof reconstructSchedule>):string {
 const headers=['SHA-256 RVT','ID спецификации','Статус','Ограничения','ElementId экземпляров','ID типа','Отбор','Правила отбора и группировки',...preview.columns.flatMap(c=>[String(c.properties.m_columnHeading??c.id),'Статус ячейки','Единицы','Источники'])];
 return '\ufeff'+[headers,...preview.rows.map(r=>[preview.source?.sha256,preview.schedule_id,'partial — review selection',preview.issues.join(' | '),r.element_ids.join(';'),r.type_id,r.membership,JSON.stringify(preview.rule_audit),...r.cells.flatMap(c=>[c.state==='value'?c.value:null,c.state,c.unit??'',JSON.stringify(c.evidence)])])].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
