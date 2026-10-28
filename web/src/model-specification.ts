import {onlyNavisSources} from './navis-format.ts';
import type {BimElement,ModelPackage} from './model';
import type {RvtDocument} from './rvt-document.ts';
import {identifier} from './rvt-document.ts';
import {elementIdentity} from './element-identity.ts';
import {elementCategory} from './element-category.ts';
import {parameter,effectiveParameter,parameterDefinitions,nativeInstanceClasses,nativeTypeId} from './rvt-schedule.ts';
import type {ParameterRecord,ValueCell} from './rvt-schedule.ts';
import {evaluateFilter,compareCells,sumCells} from './rvt-schedule-rules.ts';
import type {ReviewFilter,FilterDecision} from './rvt-schedule-rules.ts';
import {validateGostSettings} from './gost-settings.ts';
import type {GostSettings} from './gost-settings.ts';

export interface SpecColumn {id:string;label:string;kind:'base'|'property'|'rvt';path?:string[];scope?:'instance'|'type'|'effective';parameter_id?:string;source_sha256?:string}
export interface SpecInput {key:string;scene_id:string|null;source_sha256:string;name:string;element?:BimElement;native?:ParameterRecord;type?:ParameterRecord;document?:RvtDocument}
export interface SpecDataset {model:ModelPackage|null;columns:SpecColumn[];rows:SpecInput[];issues:string[];source_hashes:string[];source_metadata:Record<string,unknown>}
export interface SpecDefinition {version:1;name:string;model_id:string|null;source_hashes:string[];columns:{id:string;label:string;aggregate:'none'|'sum'|'min'|'max'}[];group_by:string[];filters:ReviewFilter[];sort:{id:string;direction:1|-1}|null;scope:'all'|'matches'|'selection';scope_ids?:string[];gost?:GostSettings}
export interface SpecRow {keys:string[];scene_ids:string[];membership:'pass'|'unknown';cells:ValueCell[]}
export interface SpecReport {contract:'UvyazkaParameterSpecification';version:1;source_metadata:Record<string,unknown>;definition:SpecDefinition;coverage:{observed:number;in_scope:number;passed:number;unknown:number;excluded:number;rows:number};selection:{key:string;state:'pass'|'fail'|'unknown';decisions:FilterDecision[]}[];rows:SpecRow[];totals:{id:string;cell:ValueCell}[];issues:string[]}
const key=(...parts:string[])=>JSON.stringify(parts);
const missing=(reason='Значение не прочитано'):ValueCell=>({state:'missing',reason,evidence:[]});
function valueCell(value:unknown,row:SpecInput,path:string[],unit?:string):ValueCell{
 const nwdSource=path[0]==='property_sets'?[...(row.element?.nwd?.property_sources??[])].reverse().find(s=>s.group===path[1]&&s.field===path[2]):undefined;
 const evidence=[{owner_id:row.key,path,value,storage_type:typeof value==='number'?'Double':'String',location:{file_sha256:row.source_sha256,scene_id:row.scene_id,native_source:row.native?.source,nwd_source:nwdSource}}];
 if(value===undefined||value===null)return {...missing(),evidence};
 if(typeof value==='boolean')return {state:'value',value:value?'true':'false',storage_type:'String',evidence};
 if(typeof value!=='string'&&typeof value!=='number'||typeof value==='number'&&!Number.isFinite(value))return {state:'unsupported',reason:'Структурное или неподдержанное значение; исходник сохранён в доказательствах',evidence};
 return {state:'value',value,storage_type:typeof value==='number'?'Double':'String',unit,evidence};
}
export function specificationDataset(model:ModelPackage|null,documents:RvtDocument[]=[]):SpecDataset{
 const rows:SpecInput[]=[],columns=new Map<string,SpecColumn>(),issues=['Выборка прочитанных записей. Полнота исходной модели, стадии, варианты и видимость Revit не подтверждены. Это новая таблица Увязки, а не пересчёт сохранённой спецификации Revit.'];
 for(const [id,label]of [['name','Наименование'],['category','Категория'],['class','Класс / тип записи'],['level','Уровень'],['model','Файл'],['id','ID сцены'],['revit','Revit ElementId'],['global','IFC GlobalId'],['material','Материалы'],['count','Количество записей']])columns.set(id,{id,label,kind:'base'});
 const docs=new Map<string,{document:RvtDocument;records:Map<string,ParameterRecord[]>}>();
 for(const d of documents){const sha=d.source?.sha256;if(!sha||d.schedule_data?.source_sha256!==sha){if(d.schedule_data)issues.push('Отброшены параметры RVT без совпадения SHA-256 источника');continue;}if(docs.has(sha)){issues.push('Повторные каталоги RVT одного источника не объединены');continue;}const records=new Map<string,ParameterRecord[]>();for(const r of d.schedule_data.records){const id=identifier(r.identity.element_id);if(id)records.set(id,[...(records.get(id)??[]),r]);}docs.set(sha,{document:d,records});if(d.schedule_data.status==='partial'||d.schedule_data.error)issues.push('Извлечение RVT неполное: '+(d.schedule_data.error||'есть непрочитанные записи'));}
 const observed=new Set<string>();const metadataCaptions=new WeakMap<object,Map<string,string>>();
 for(const e of model?.elements??[]){if(!['element','space'].includes(e.role))continue;const member=model!.federation?.members.find(m=>m.instance_id===e.source_instance_id);const sha=member?.source_sha256??(model!.source.format==='rvt'?model!.source.sha256:e.source.file_sha256||model!.source.sha256),doc=docs.get(sha),nativeId=elementIdentity(e).element_id,found=nativeId?doc?.records.get(nativeId):null,native=found?.length===1?found[0]:undefined;rows.push({key:key(sha,e.id),scene_id:e.id,source_sha256:sha,name:e.name,element:e,native,document:doc?.document});if(nativeId)observed.add(key(sha,nativeId));}
 for(const [sha,doc]of docs)for(const [id,records]of doc.records){if(records.length!==1){issues.push('Неоднозначный Revit ID '+id+'; параметры не присоединены автоматически');continue;}const native=records[0];if(!nativeInstanceClasses.has(native.class_name)||observed.has(key(sha,id)))continue;rows.push({key:key(sha,'rvt:'+id),scene_id:null,source_sha256:sha,name:'Revit #'+id,native,document:doc.document});}
 const addPath=(root:string,value:unknown,path:string[]=[])=>{
  if(value&&typeof value==='object'&&!Array.isArray(value)&&!('value_si'in value)&&!('value'in value&&'unit'in value)){for(const [name,v]of Object.entries(value))addPath(root,v,[...path,name]);return;}
  if(!path.length)return;const id=key(root,...path);columns.set(id,{id,label:({property_sets:'Свойства',quantity_sets:'Количества',source_quantities:'Величины источника'} as Record<string,string>)[root]+' · '+path.join(' · '),kind:'property',path:[root,...path]});
 };
 for(const row of rows){const doc=docs.get(row.source_sha256);const typeId=row.native?nativeTypeId(row.native):null,types=typeId?doc?.records.get(typeId):null;row.type=types?.length===1&&!nativeInstanceClasses.has(types[0].class_name)?types[0]:undefined;
  if(row.element){for(const root of ['property_sets','quantity_sets','source_quantities'] as const)addPath(root,row.element[root]);if(row.element.semantic_kind==='geometry_fragment'&&!issues.some(s=>s.startsWith('NWD:')))issues.push('NWD: строки соответствуют геометрическим фрагментам. Сумма записей не является количеством оборудования.');}
  for(const scope of ['instance','type']as const){const m=(scope==='instance'?row.native:row.type)?.saved_metadata;if(!m)continue;const parameters=[...(m.parameter_sets??[]).flatMap((s:any)=>s.parameters??[]),...(m.raw_field_parameters??[]),...(m.resolved_family_parameters??[]),...(m.family_parameter_slots??[]),...((scope==='instance'?row.native:row.type)?.workset?.status==='decoded'?[{parameter_id:-1002053}]:[])];for(const p of parameters){const pid=identifier(p.serialized_parameter_id??p.parameter_id);if(!pid)continue;let captionIndex=metadataCaptions.get(m);if(!captionIndex){captionIndex=new Map();const sets=new Map<string,Set<string>>();for(const d of parameterDefinitions((scope==='instance'?row.native:row.type)!,row.document?.schedule_data)){const id=identifier(d.parameter_id);if(id&&typeof d.caption==='string'&&d.caption.trim()){const set=sets.get(id)??new Set<string>();set.add(d.caption);sets.set(id,set);}}for(const [id,set] of sets)if(set.size===1)captionIndex.set(id,[...set][0]);metadataCaptions.set(m,captionIndex);}const builtin:Record<string,string>={'-1002053':'Рабочий набор (ID)','-1001301':'Ширина','-1001300':'Высота','-1001405':'Марка типа','-1010103':'Описание','-1001206':'Огнестойкость'};const caption=captionIndex.get(pid)??builtin[pid];const id=key('rvt',row.source_sha256,scope,pid);if(!columns.has(id))columns.set(id,{id,label:`RVT · ${scope==='instance'?'экземпляр':'тип'} · ${caption?caption+' · ':''}#${pid}${docs.size>1?' · '+(row.document?.source?.filename??row.source_sha256.slice(0,8)):''}`,kind:'rvt',scope,parameter_id:pid,source_sha256:row.source_sha256});}}
 }
 for(const c of [...columns.values()])if(c.kind==='rvt'){
  const id=key('rvt',c.source_sha256!,'effective',c.parameter_id!);if(!columns.has(id))columns.set(id,{...c,id,scope:'effective',label:c.label.replace(/RVT · (экземпляр|тип) · /,'RVT · значение · ')});
 }
 return {model,source_metadata:{engine:'uvyazka-parameter-specification-v1',model:model?{model_id:model.model_id,source:model.source,importer_version:model.importer_version,members:model.federation?.members}:null,native_catalogues:[...docs.values()].map(({document:d})=>({source:d.source,schema_version:d.schema_version,schema_sha256:d.schema_sha256,status:d.status,scope:d.schedule_data?.scope,shared_store:d.shared_store}))},columns:[...columns.values()],rows,issues:[...new Set(issues)],source_hashes:[...new Set(rows.map(r=>r.source_sha256))].sort()};
}
export function specificationCell(dataset:SpecDataset,row:SpecInput,column:SpecColumn):ValueCell{
 if(column.kind==='rvt'&&column.source_sha256!==row.source_sha256)return missing('Параметр другого исходного файла');
 if(column.kind==='rvt')return column.scope==='effective'?effectiveParameter(row.native,row.type,column.parameter_id!):parameter(column.scope==='type'?row.type:row.native,column.parameter_id!);
 if(column.kind==='property'){
  let value:any=row.element;for(const name of column.path??[])value=value?.[name];
  let unit:string|undefined;if(value&&typeof value==='object'&&!Array.isArray(value)){
   if('value_si'in value){unit=typeof value.unit==='string'?value.unit:undefined;value=value.value_si;}
   else if('value'in value&&'unit'in value){unit=typeof value.unit==='string'?value.unit:undefined;value=value.value;}
  }
  return valueCell(value,row,column.path??[],unit);
 }
 const e=row.element,m=dataset.model;
 const values:Record<string,unknown>={name:row.name,category:e&&m?elementCategory(e,m).name:undefined,class:e?.class??row.native?.class_name,level:m?.storeys.find(s=>s.id===e?.storey_id)?.name,model:row.document?.source?.filename??m?.federation?.members.find(s=>s.source_sha256===row.source_sha256)?.label??m?.source.filename,id:row.scene_id??undefined,revit:e?elementIdentity(e).element_id:row.native?.identity.element_id,global:e?.global_id||undefined,material:e?.materials.length?e.materials.join('; '):undefined,count:1};
 const cell=valueCell(values[column.id],row,[column.id],column.id==='count'?'record':undefined);if(column.id==='count')cell.storage_type='Integer';return cell;
}
function merge(cells:ValueCell[]):ValueCell{if(cells.length===1)return cells[0];const evidence=cells.flatMap(c=>c.evidence);if(cells.some(c=>c.state!=='value'))return {state:cells.some(c=>c.state==='conflict')?'conflict':cells.some(c=>c.state==='unsupported')?'unsupported':cells.some(c=>c.state==='mixed')?'mixed':'missing',reason:'Значение прочитано не для всех записей группы',evidence};if(new Set(cells.map(c=>JSON.stringify([c.value,c.storage_type,c.unit]))).size>1)return {state:'mixed',reason:'В группе разные значения',evidence};return {...cells[0],evidence};}
function aggregate(cells:ValueCell[],mode:'sum'|'min'|'max'):ValueCell{
 if(cells.some(c=>!c.unit||c.unit==='native'||c.unit.startsWith('unknown')))return {state:'unsupported',reason:'Итог не рассчитан: единицы части значений не подтверждены',evidence:cells.flatMap(c=>c.evidence)};
 const total=sumCells(cells);if(total.state!=='value'||mode==='sum')return total;
 const chosen=cells.reduce((best,c)=>mode==='min'?(Number(c.value)<Number(best.value)?c:best):(Number(c.value)>Number(best.value)?c:best));return {...chosen,evidence:cells.flatMap(c=>c.evidence)};
}
export function defaultSpecification(dataset:SpecDataset):SpecDefinition{return {version:1,name:'Ведомость по параметрам',model_id:dataset.model?.model_id??null,source_hashes:dataset.source_hashes,columns:['name','category',(dataset.model&&onlyNavisSources(dataset.model))?'id':dataset.model?.source.format==='rvt'||!dataset.model&&dataset.rows.some(r=>r.native)?'revit':'global','count'].map(id=>({id,label:dataset.columns.find(c=>c.id===id)!.label,aggregate:id==='count'?'sum':'none'})),group_by:[],filters:[],sort:null,scope:'all'};}
export function validateSpecification(input:unknown):SpecDefinition{
 if((input as SpecDefinition)?.gost!==undefined)validateGostSettings((input as SpecDefinition).gost);
 const x=input as SpecDefinition;if(!x||x.version!==1||typeof x.name!=='string'||!x.name.trim()||x.name.length>120||!Array.isArray(x.source_hashes)||x.source_hashes.length>1000||x.source_hashes.some(h=>!/^([a-f0-9]{64})$/.test(h))||x.model_id!==null&&!/^[a-f0-9]{64}$/.test(x.model_id))throw Error('Неверная версия или источники спецификации');
 if(!Array.isArray(x.columns)||!x.columns.length||x.columns.length>40||new Set(x.columns.map(c=>c.id)).size!==x.columns.length||x.columns.some(c=>typeof c.id!=='string'||c.id.length>2048||typeof c.label!=='string'||c.label.length>256||!['none','sum','min','max'].includes(c.aggregate)))throw Error('Нужны 1–40 уникальных полей');
 if(!Array.isArray(x.group_by)||x.group_by.some(id=>!x.columns.some(c=>c.id===id))||!['all','matches','selection'].includes(x.scope)||x.scope_ids&&(!Array.isArray(x.scope_ids)||x.scope_ids.length>500000||x.scope_ids.some(id=>typeof id!=='string')))throw Error('Неверная область или группировка');
 if(!Array.isArray(x.filters)||x.filters.length>100||x.filters.some(f=>!f||typeof f.field_id!=='string'||!['equal','not_equal','greater','greater_equal','less','less_equal','contains','not_contains','begins','ends','has_value'].includes(f.operator)||f.value!==undefined&&typeof f.value!=='string'&&!(typeof f.value==='number'&&Number.isFinite(f.value))||f.unit!==undefined&&typeof f.unit!=='string'))throw Error('Неверные условия отбора');
 if(x.sort&&(!x.columns.some(c=>c.id===x.sort!.id)||![1,-1].includes(x.sort.direction)))throw Error('Неверная сортировка');return structuredClone(x);
}
export function buildSpecification(dataset:SpecDataset,input:SpecDefinition,scopeIds?:string[]):SpecReport{
 const definition=validateSpecification(input);if(definition.model_id!==(dataset.model?.model_id??null)||JSON.stringify([...definition.source_hashes].sort())!==JSON.stringify(dataset.source_hashes))throw Error('Настройки относятся к другому источнику или ревизии модели');
 const columns=new Map(dataset.columns.map(c=>[c.id,c]));for(const c of definition.columns)if(!columns.has(c.id))throw Error('Поле не найдено в текущих данных: '+c.label);
 const scopes=definition.scope==='all'?null:new Set(scopeIds??definition.scope_ids??[]);if(scopes)definition.scope_ids=[...scopes];
 let passed=0,unknown=0,excluded=0,in_scope=0;const selection:SpecReport['selection']=[];const candidates:{row:SpecInput;cells:Map<string,ValueCell>;membership:'pass'|'unknown'}[]=[];
 for(const row of dataset.rows){if(scopes&&(!row.scene_id||!scopes.has(row.scene_id)))continue;in_scope++;const cells=new Map<string,ValueCell>();const read=(id:string)=>{let c=cells.get(id);if(!c){c=columns.has(id)?specificationCell(dataset,row,columns.get(id)!):missing('Поле фильтра не найдено');cells.set(id,c);}return c;};const decisions=definition.filters.map(f=>{const c=read(f.field_id);if(f.operator!=='has_value'&&typeof c.value==='number'&&c.storage_type!=='ElementId'&&(!c.unit||c.unit==='native'))return {state:'unknown' as const,reason:'Единицы числового значения не подтверждены',filter:f,cell:c};return evaluateFilter(f,c);});if(decisions.some(d=>d.state==='fail')){selection.push({key:row.key,state:'fail',decisions});excluded++;continue;}const membership=decisions.some(d=>d.state==='unknown')?'unknown':'pass';selection.push({key:row.key,state:membership,decisions});if(membership==='pass')passed++;else unknown++;for(const c of definition.columns)read(c.id);candidates.push({row,cells,membership});}
 const groups=new Map<string,typeof candidates>();for(const r of candidates){const values=definition.group_by.map(id=>r.cells.get(id)!);const g=definition.group_by.length&&values.every(c=>c.state==='value')?JSON.stringify([r.membership,...values.map(c=>[c.storage_type,c.value,c.unit])]):r.row.key;const bucket=groups.get(g);if(bucket)bucket.push(r);else groups.set(g,[r]);}
 const rows:SpecRow[]=[...groups.values()].map(rs=>({keys:rs.map(r=>r.row.key),scene_ids:rs.flatMap(r=>r.row.scene_id?[r.row.scene_id]:[]),membership:rs[0].membership,cells:definition.columns.map(c=>c.aggregate==='none'?merge(rs.map(r=>r.cells.get(c.id)!)):rs[0].membership==='unknown'?{state:'unsupported',reason:'Итог группы не рассчитан: отбор не подтверждён',evidence:rs.flatMap(r=>r.cells.get(c.id)!.evidence)}:aggregate(rs.map(r=>r.cells.get(c.id)!),c.aggregate))}));
 if(definition.sort){const i=definition.columns.findIndex(c=>c.id===definition.sort!.id);rows.sort((a,b)=>compareCells(a.cells[i],b.cells[i],definition.sort!.direction));}
 return {contract:'UvyazkaParameterSpecification',version:1,source_metadata:dataset.source_metadata,definition,selection,coverage:{observed:dataset.rows.length,in_scope,passed,unknown,excluded,rows:rows.length},rows,totals:definition.columns.filter(c=>c.aggregate!=='none').map(c=>({id:c.id,cell:aggregate(candidates.filter(r=>r.membership==='pass').map(r=>r.cells.get(c.id)!),c.aggregate as 'sum'|'min'|'max')})),issues:[...dataset.issues,...(unknown?['Итоги включают только записи с подтверждённым отбором; строки «Неизвестно» показаны отдельно.']:[])]};
}
export function specificationCsv(report:SpecReport):string{
 const escape=(v:unknown)=>{let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 const rows:unknown[][]=[['Источники SHA-256','ID записей','ID сцены','Отбор',...report.definition.columns.flatMap(c=>[c.label,c.label+' · единица',c.label+' · статус'])]];
 for(const row of report.rows)rows.push([report.definition.source_hashes.join(';'),row.keys.join(';'),row.scene_ids.join(';'),row.membership,...row.cells.flatMap(c=>[c.state==='value'?c.value:c.reason,c.unit??'',c.state])]);
 rows.push(['Итоги подтверждённого отбора','','','',...report.definition.columns.flatMap(c=>{const cell=report.totals.find(t=>t.id===c.id)?.cell;return cell?[cell.state==='value'?cell.value:cell.reason,cell.unit??'',cell.state]:['','',''];})]);return '\ufeff'+rows.map(row=>row.map(escape).join(',')).join('\r\n');
}
