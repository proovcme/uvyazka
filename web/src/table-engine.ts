/** DOM-free entrypoint. The viewer imports these same implementations directly. */
import {specificationDataset,defaultSpecification,validateSpecification,buildSpecification,specificationCsv} from './model-specification.ts';
import {reconstructSchedule,previewCsv} from './rvt-schedule.ts';
import {buildGost,proposeGost} from './gost-specification.ts';
import {gostXlsx} from './specification-xlsx.ts';
import type {ModelPackage} from './model.ts';
import type {RvtDocument} from './rvt-document.ts';

export const contract='uvyazka-shared-tables-v1';
interface Input {model?:ModelPackage|null;documents?:RvtDocument[];kind?:string;definition?:unknown;element_id?:string;options?:any;project_id?:string}
export function describe(input:Input){
 const dataset=specificationDataset(input.model??null,input.documents??[]);
 return {contract,columns:dataset.columns,source_hashes:dataset.source_hashes,observed:dataset.rows.length,issues:dataset.issues,default_definition:defaultSpecification(dataset),gost_proposal:proposeGost(dataset)};
}
export function build(input:Input){
 if(input.kind==='native_schedule'){
  const matches=(input.documents??[]).flatMap(document=>document.records.filter(r=>r.kind==='schedule'&&String(r.identity.element_id)===input.element_id).map(record=>({document,record})));
  if(matches.length!==1)throw Error('Нужна одна спецификация с точным Revit ID в выбранном источнике');
  return {contract,kind:'native_schedule',report:reconstructSchedule(matches[0].record,matches[0].document,input.options??{grouping:'schedule'})};
 }
 const dataset=specificationDataset(input.model??null,input.documents??[]);
 const definition=validateSpecification(input.definition??defaultSpecification(dataset));
 if(input.kind==='gost')return {contract,kind:'gost',report:buildGost(dataset,definition,undefined,input.project_id??'')};
 if(input.kind&&input.kind!=='parameters')throw Error('Неизвестный вид таблицы');
 return {contract,kind:'parameters',report:buildSpecification(dataset,definition)};
}
export function render(input:{kind:string;report:any;format:string}){
 if(input.format==='json')return JSON.stringify(input.report);
 if(input.format==='csv'&&input.kind==='parameters')return specificationCsv(input.report);
 if(input.format==='csv'&&input.kind==='native_schedule')return previewCsv(input.report);
 if(input.format==='xlsx'&&input.kind==='gost')return Array.from(gostXlsx(input.report));
 throw Error('Формат недоступен для этой таблицы');
}
