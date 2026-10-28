import type {ValueCell} from './rvt-schedule.ts';
import {identifier,schedule} from './rvt-document.ts';
import type {NativeRecord} from './rvt-document.ts';
import {evaluateFilter} from './rvt-schedule-rules.ts';
import type {ReviewFilter,FilterDecision} from './rvt-schedule-rules.ts';

// Autodesk ScheduleFilterType: official API reference, 2026. Revit 2024
// enum values independently checked. File layout remains an observed subset.
// https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/9b696f55-de40-8739-8cfb-decd51995cff.htm
const operators:Record<number,ReviewFilter['operator']>={2:'equal',3:'not_equal',4:'greater',5:'greater_equal',6:'less',7:'less_equal',8:'contains',9:'not_contains',10:'begins',11:'begins',12:'ends',13:'ends'};
const operatorLabels:Record<number,string>={2:'равно',3:'не равно',4:'больше',5:'не меньше',6:'меньше',7:'не больше',8:'содержит',9:'не содержит',10:'начинается с',11:'не начинается с',12:'заканчивается на',13:'не заканчивается на'};
/** Same ordered pointers and field IDs as reconstruction, including hidden fields. */
export function nativeFilterSummary(record:NativeRecord){
 const definition=schedule(record),pointers=definition.schema?.m_filterArr;
 const rules=definition.rules.filter(r=>r.field==='m_filterArr');
 const rows=rules.map(source=>{
  const raw=source.properties as any,parsed=nativeFilter(raw),id=identifier(raw?.m_fieldId);
  const fields=definition.columns.filter(c=>c.id===id),field=fields.length===1?fields[0]:null;
  return {field:String(field?.properties.m_columnHeading||'Поле '+(id??'не прочитано')),field_id:id,hidden:field?.properties.m_hidden===true,
   condition:operatorLabels[raw?.m_filterType]??'Условие не поддержано',value:parsed?.filter.value,
   storage:parsed?.storage,state:parsed&&field?'supported_requires_review':'unknown',source};
 });
 return {count:Array.isArray(pointers)?pointers.length:null,complete:Array.isArray(pointers)&&rows.length===pointers.length&&rows.every(r=>r.state==='supported_requires_review'),rows};
}
export function nativeFilter(properties:any):{filter:ReviewFilter;storage:string;negate:boolean}|null {
 const field=identifier(properties?.m_fieldId),operator=operators[properties?.m_filterType],v=properties?.m_value;
 if(field===null||!operator||!v)return null;
 const storage=({1:'Integer',2:'Double',3:'String',4:'ElementId'}as Record<number,string>)[v.m_storageType];
 const value=storage==='String'?v.m_str?.m_str:storage==='Integer'?v.m_int:storage==='Double'?v.m_dbl:storage==='ElementId'?Number(identifier(v.m_elemId)):undefined;
 if(!storage||typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value)&&(storage==='Double'||Number.isSafeInteger(value))))return null;
 if(storage==='ElementId'&&identifier(v.m_elemId)===null)return null;
 return {filter:{field_id:field,operator,value},storage,negate:[11,13].includes(properties.m_filterType)};
}
export function evaluateNativeFilter(rule:NonNullable<ReturnType<typeof nativeFilter>>,cell:ValueCell|undefined):FilterDecision {
 const filter={...rule.filter,unit:cell?.unit};
 if(cell?.state==='value'&&cell.storage_type!==rule.storage)return {state:'unknown',reason:'Тип сохранённого порога не совпадает с типом параметра.',filter,cell};
 const result=evaluateFilter(filter,cell);
 if(rule.negate&&result.state!=='unknown')result.state=result.state==='pass'?'fail':'pass';
 result.reason='Сохранённый фильтр RVT, профиль Увязки; '+result.reason;
 return result;
}
