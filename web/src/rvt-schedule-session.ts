import type {ScheduleOptions} from './rvt-schedule.ts';
const operators=new Set(['equal','not_equal','greater','greater_equal','less','less_equal','contains','not_contains','begins','ends','has_value']);
export function readScheduleSettings(raw:string|null,sha:string,scheduleId:string):ScheduleOptions {
 if(raw===null)return {grouping:'schedule',filters:[],sum_fields:[]};
 const saved=JSON.parse(raw),s=saved.settings;
 if(saved.version!==1||saved.source_sha256!==sha||saved.schedule_id!==scheduleId||!s||!['schedule','instances','type'].includes(s.grouping)||!Array.isArray(s.filters)||!Array.isArray(s.sum_fields))throw new Error('Настройки не соответствуют модели или версии формата.');
 if(s.filters.some((f:any)=>!f||typeof f.field_id!=='string'||!operators.has(f.operator)||f.operator!=='has_value'&&!(typeof f.value==='string'||typeof f.value==='number'&&Number.isFinite(f.value))||f.unit!==undefined&&!['ft','native'].includes(f.unit))||s.sum_fields.some((f:any)=>typeof f!=='string'))throw new Error('Повреждены правила сверки.');
 return s;
}
export function writeScheduleSettings(settings:ScheduleOptions,sha:string,scheduleId:string):string {
 return JSON.stringify({version:1,source_sha256:sha,schedule_id:scheduleId,updated_at:new Date().toISOString(),settings});
}
