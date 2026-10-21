import {identifier,schedule,csvCell} from './rvt-document.ts';
import type {NativeRecord,RvtDocument} from './rvt-document.ts';

export interface ParameterRecord {
 identity:{element_id:number|string};class_name:string;status:string;source:unknown;
 root_fields?:Record<string,any>;saved_metadata?:Record<string,any>|null;metadata_diagnostic?:string;
}
export interface ScheduleData {source_sha256:string;status:string;error?:string;scope:string[];records:ParameterRecord[];summary?:any;clipped_records?:number}
export interface Evidence {owner_id:string;path:(string|number)[];value:unknown;storage_type:string;location:unknown;rule?:string}
export interface ValueCell {state:'value'|'missing'|'conflict'|'unsupported'|'mixed';value?:string|number;storage_type?:string;unit?:string;reason?:string;evidence:Evidence[]}
export interface PreviewRow {element_ids:string[];type_id:string|null;cells:ValueCell[]}
// Narrow, explicit fallback for the same built-in IDs documented by the pinned
// rvt-rs partition_type_parameters.rs (RE-77/RE-93). Never choose a nonzero slot
// or match a caption. Kept distinct from file-owned parameter definitions.
const builtinSlots:Record<string,{storage:string;unit?:string}>={
 '-1001301':{storage:'Double',unit:'ft'},'-1001300':{storage:'Double',unit:'ft'},
 '-1001405':{storage:'String'},'-1010103':{storage:'String'},'-1001206':{storage:'String'}
};
const missing=(reason:string):ValueCell=>({state:'missing',reason,evidence:[]});
function parameter(owner:ParameterRecord|undefined,id:string):ValueCell {
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
function mergeCells(cells:ValueCell[]):ValueCell {
 if(cells.length===1)return cells[0];
 const evidence=[...new Map(cells.flatMap(c=>c.evidence).map(e=>[JSON.stringify(e),e])).values()];
 if(cells.some(c=>c.state==='conflict'))return {state:'conflict',reason:'Конфликт в одном из экземпляров',evidence};
 if(cells.some(c=>c.state==='unsupported'))return {state:'unsupported',reason:'Тип или правило одного из значений не поддержаны',evidence};
 if(cells.some(c=>c.state==='missing'))return {state:'missing',reason:'Не все экземпляры имеют прочитанное значение',evidence};
 if(new Set(cells.map(c=>JSON.stringify([c.state,c.storage_type,c.value,c.unit]))).size>1)return {state:'mixed',reason:'Разные значения у экземпляров группы',evidence};
 return {...cells[0],evidence};
}
export function reconstructSchedule(record:NativeRecord,document:RvtDocument,groupByType=false){
 const definition=schedule(record),s=definition.schema,data=document.schedule_data;
 const columns=definition.columns.filter(c=>c.properties.m_hidden!==true);
 const issues:string[]=['Сверочная выборка экземпляров семейств по категории. Стадии, варианты, область видимости, связи и правила Revit не применены. Это не вычисленное тело Revit.'];
 const rows:PreviewRow[]=[];let unresolved=0;
 const result=()=>({status:'partial' as const,rows,columns,issues,unresolved_instances:unresolved,source:document.source,schedule_id:record.identity.element_id,category_id:identifier(s?.m_categoryId),group_by_type:groupByType,instance_count:rows.reduce((n,r)=>n+r.element_ids.length,0)});
 if(!data){issues.push('Параметры элементов пока не прочитаны.');return result();}
 if(!document.source?.sha256||data.source_sha256!==document.source.sha256){issues.push('SHA-256 параметров не совпадает с исходным RVT.');return result();}
 if(!s){issues.push('Определение спецификации не прочитано.');return result();}
 const categoryId=identifier(s.m_categoryId);
 if(!categoryId||categoryId==='-1'){issues.push('Категория не определена; выборка не построена.');return result();}
 if(s.m_bMaterialSchedule||s.m_bRefTable||s.m_isEmbedded){issues.push('Материальная, ключевая или вложенная спецификация не поддерживается.');return result();}
 if((s.m_filterArr??[]).length)issues.push('Фильтры спецификации не применены: показаны кандидаты категории.');
 if((s.m_sortFieldArr??[]).length)issues.push('Сортировка и группировка Revit не воспроизведены. Группирование по типу — отдельная операция Увязки.');
 if(data.status==='partial'||data.error)issues.push('Нативное извлечение параметров неполное'+(data.error?': '+data.error:'.'));
 if(definition.issues.length)issues.push(...definition.issues);
 const index=new Map<string,ParameterRecord[]>();
 for(const r of data.records){const id=String(r.identity.element_id);index.set(id,[...(index.get(id)??[]),r]);}
 const unique=(id:string|null)=>{const rs=id===null?undefined:index.get(id);return rs?.length===1?rs[0]:undefined;};
 const groupMap=new Map<string,PreviewRow[]>();
 for(const r of data.records){
  if(r.class_name!=='FamilyInstance')continue;
  const id=String(r.identity.element_id);if(index.get(id)!.length!==1){unresolved++;continue;}
  const cat=parameter(r,'-1140363');if(cat.state!=='value'){unresolved++;continue;}if(String(cat.value)!==categoryId)continue;
  const typeId=identifier(r.saved_metadata?.root_references?.m_masterSymbolId),typeCandidate=unique(typeId),type=typeCandidate?.class_name==='FamilySymbol'?typeCandidate:undefined;
  const cells=columns.map(c=>{
   const f=c.properties,pid=identifier(f.m_paramElemId);
   if(f.m_pExpression?.pointer_token!==0&&f.m_pExpression?.pointer_token!==undefined||f.m_oCustomFieldData?.pointer_token||f.m_combineParameters?.length||identifier(f.m_percentageOfId)!==null&&identifier(f.m_percentageOfId)!=='-1')return {state:'unsupported' as const,reason:'Формула, процент, объединённое или пользовательское поле не вычисляется',evidence:[]};
   if(f.m_sourceType===2&&pid==='-1152353')return {state:'value' as const,value:1,storage_type:'Integer',evidence:[{owner_id:id,path:['identity','element_id'],value:1,storage_type:'Integer',location:r.source,rule:'one_per_observed_unique_family_instance'}]};
   if(!pid||![0,1].includes(f.m_sourceType))return {state:'unsupported' as const,reason:'Источник поля не поддержан',evidence:[]};
   return parameter(f.m_sourceType===1?type:r,pid);
  });
  const row={element_ids:[id],type_id:typeId,cells};
  // Unknown types stay separate; no accidental group of all missing types.
  const key=groupByType&&typeId&&type?typeId:'instance:'+id;groupMap.set(key,[...(groupMap.get(key)??[]),row]);
 }
 for(const group of groupMap.values())rows.push({element_ids:group.flatMap(r=>r.element_ids),type_id:group[0].type_id,cells:columns.map((c,i)=>c.properties.m_sourceType===2&&identifier(c.properties.m_paramElemId)==='-1152353'&&group.every(r=>r.cells[i].state==='value')?{state:'value',value:group.length,storage_type:'Integer',evidence:group.flatMap(r=>r.cells[i].evidence)}:mergeCells(group.map(r=>r.cells[i])))});
 if(unresolved)issues.push(`${unresolved} записей экземпляров с неизвестной категорией или неоднозначным ID исключены; полнота не подтверждена.`);
 if(!rows.length)issues.push('Подтверждённых кандидатов не найдено. Это не нулевое количество в проекте.');
 return result();
}
export function previewValue(cell:ValueCell):string {
 if(cell.state!=='value')return ({missing:'Не прочитано',conflict:'Конфликт',unsupported:'Не поддержано',mixed:'Разные значения'})[cell.state];
 if(cell.value==='')return 'Пустая строка';
 if(cell.unit==='ft'&&typeof cell.value==='number')return `${Number((cell.value*304.8).toFixed(6)).toLocaleString('ru-RU')} мм`;
 return cell.storage_type==='ElementId'?`ID ${cell.value}`:`${cell.value}${cell.unit==='ft'?' ft':cell.unit==='native'?' (исх. ед.)':''}`;
}
export function previewCsv(preview:ReturnType<typeof reconstructSchedule>):string {
 const headers=['SHA-256 RVT','ID спецификации','Статус','Ограничения','ElementId экземпляров','ID типа',...preview.columns.flatMap(c=>[String(c.properties.m_columnHeading??c.id),'Статус ячейки','Единицы','Источники'])];
 return '\ufeff'+[headers,...preview.rows.map(r=>[preview.source?.sha256,preview.schedule_id,'partial — category candidates',preview.issues.join(' | '),r.element_ids.join(';'),r.type_id,...r.cells.flatMap(c=>[c.state==='value'?c.value:null,c.state,c.unit??'',JSON.stringify(c.evidence)])])].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
