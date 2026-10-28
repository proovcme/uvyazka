import test from 'node:test';
import assert from 'node:assert/strict';
import {reconstructSchedule,previewValue,previewCsv} from '../src/rvt-schedule.ts';
import type {ParameterRecord} from '../src/rvt-schedule.ts';
import type {NativeRecord,RvtDocument} from '../src/rvt-document.ts';
import {evaluateFilter,sumCells} from '../src/rvt-schedule-rules.ts';
import {readScheduleSettings,writeScheduleSettings} from '../src/rvt-schedule-session.ts';

function owner(id:number,kind='FamilyInstance',category=-2000023,type=100):ParameterRecord {
 return {identity:{element_id:id},class_name:kind,status:'complete_bounded_graph',source:{body_sha256:'body-'+id},saved_metadata:{root_references:{m_masterSymbolId:type},raw_field_parameters:[{parameter_id:-1140363,storage_type:'ElementId',raw_value:category}],parameter_sets:[],resolved_family_parameters:[],family_parameter_slots:[]}};
}
function value(r:ParameterRecord,id:number,raw:unknown,storage='String') {r.saved_metadata!.parameter_sets.push({parameters:[{serialized_parameter_id:id,storage_type:storage,raw_value:raw}]});}
function fixture(fields:{id:number;source?:number;extra?:any}[]=[{id:10},{id:11,source:1},{id:-1152353,source:2}]){
 const record:NativeRecord={identity:{element_id:50},class_name:'DBViewSchedule',kind:'schedule',status:'complete_bounded_graph',source:{},graph:{objects:[{class_name:'DBViewSchedule',fields:{m_pSchema:{offset:1,pointer_token:1}}},{class_name:'ScheduleSchema',fields:{m_categoryId:-2000023,m_filterArr:[],m_sortFieldArr:[],m_fieldIds:fields.map((_,i)=>({m_id:i})),m_pFields:fields.map((_,i)=>({offset:i+10,pointer_token:1}))}}],edges:[{source_object_index:0,pointer_offset:1,target_object_index:1}]}};
 fields.forEach((f,i)=>{record.graph!.objects.push({class_name:'ScheduleField',fields:{m_columnHeading:'Same caption',m_paramElemId:f.id,m_sourceType:f.source??0,m_pExpression:{pointer_token:0},...f.extra}});record.graph!.edges.push({source_object_index:1,pointer_offset:10+i,target_object_index:2+i});});
 const a=owner(1),b=owner(2),t=owner(100,'FamilySymbol');value(a,10,'A');value(b,10,'B');value(t,11,'Type value');
 const doc:RvtDocument={schema_version:1,schema_sha256:'schema',status:'extracted_requires_review',clipped_records:0,records:[record],summary:{},source:{filename:'synthetic.rvt',sha256:'file-hash',size_bytes:1},evaluated_schedule_body_available:false,schedule_data:{source_sha256:'file-hash',status:'extracted_requires_review',scope:['FamilyInstance','FamilySymbol'],records:[a,b,t]}};
 return {record,doc,a,b,t};
}
test('preview uses category, parameter ID and explicit type link; includes instances without geometry',()=>{
 const {record,doc}=fixture();doc.schedule_data!.records.push(owner(3,'FamilyInstance',-2000014));
 const p=reconstructSchedule(record,doc);assert.equal(p.instance_count,2);assert.deepEqual(p.rows[0].cells.map(c=>c.value),['A','Type value',1]);
 assert.equal(p.rows[0].cells[1].evidence[0].owner_id,'100');assert.equal(p.status,'partial');
});
test('different file hash refuses cross-project parameter joins',()=>{const {record,doc}=fixture();doc.schedule_data!.source_sha256='different';assert.equal(reconstructSchedule(record,doc).rows.length,0);});
test('type grouping preserves members, derives counts and marks mixed instance values',()=>{
 const {record,doc}=fixture();const p=reconstructSchedule(record,doc,true);assert.equal(p.rows.length,1);assert.deepEqual(p.rows[0].element_ids,['1','2']);assert.equal(p.rows[0].cells[0].state,'mixed');assert.equal(p.rows[0].cells[1].value,'Type value');assert.equal(p.rows[0].cells[2].value,2);assert.equal(p.rows[0].cells[1].evidence.length,1);assert.equal(p.rows[0].cells[2].evidence.length,2);
});
test('zero, empty string, missing values and conflicting evidence remain distinct',()=>{
 const {record,doc,a,b}=fixture([{id:10},{id:20},{id:21},{id:22}]);a.saved_metadata!.parameter_sets=[];
 value(a,10,0,'Integer');value(a,20,'');value(a,22,'x');value(a,22,'y');
 const c=reconstructSchedule(record,doc).rows[0].cells;assert.equal(c[0].value,0);assert.equal(c[1].value,'');assert.equal(c[2].state,'missing');assert.equal(c[3].state,'conflict');
 value(b,20,'');const g=reconstructSchedule(record,doc,true);assert.equal(g.rows[0].cells[2].state,'missing');
});
test('unknown family slot types and formula fields are not guessed or evaluated',()=>{
 const {record,doc,a}=fixture([{id:777},{id:-1152353,source:2,extra:{m_pExpression:{pointer_token:1}}}]);a.saved_metadata!.family_parameter_slots=[{parameter_id:777,double_slot:12,integer_slot:0,string_slot:'',element_id_slot:-1}];
 const p=reconstructSchedule(record,doc,true);assert.equal(p.rows[0].cells[0].state,'unsupported');assert.notEqual(p.rows[0].cells[1].state,'value');
});
test('narrow builtin projection retains native feet and source path; display converts to mm',()=>{
 const {record,doc,t}=fixture([{id:-1001301,source:1}]);t.saved_metadata!.family_parameter_slots=[{parameter_id:-1001301,double_slot:1,integer_slot:99,string_slot:'wrong',element_id_slot:0}];
 const c=reconstructSchedule(record,doc).rows[0].cells[0];assert.equal(c.value,1);assert.equal(c.unit,'ft');assert.equal(previewValue(c),'304,8 мм');assert.match(c.evidence[0].rule! ,/RE-77\/RE-93/);
});
test('unknown categories and duplicate identities cannot silently become zero or doubled counts',()=>{
 const {record,doc,a}=fixture();doc.schedule_data!.records.push({...a});const u=owner(9);u.saved_metadata!.raw_field_parameters=[];doc.schedule_data!.records.push(u);
 const p=reconstructSchedule(record,doc);assert.equal(p.instance_count,1);assert.equal(p.unresolved_instances,3);assert.ok(p.issues.some(s=>s.includes('не подтверждена')));
});
test('filters are reported as unapplied; CSV carries provenance, cell states and injection protection',()=>{
 const {record,doc,a}=fixture();record.graph!.objects[1].fields.m_filterArr=[{pointer_token:1,offset:999}];a.saved_metadata!.parameter_sets=[];value(a,10,'=SUM(A1)');
 const p=reconstructSchedule(record,doc);assert.equal(p.instance_count,2);assert.ok(p.issues.some(s=>s.includes('Фильтры')));const csv=previewCsv(p);assert.match(csv,/'=SUM/);assert.match(csv,/file-hash/);assert.match(csv,/partial/);assert.match(csv,/body-1/);
});

function sortRule(record:NativeRecord,id:number,order=0){
 const schema=record.graph!.objects[1].fields,n=record.graph!.objects.length,offset=1000+n;
 (schema.m_sortFieldArr??=[]).push({pointer_token:1,offset});schema.m_bInstanceSchedule=false;
 record.graph!.objects.push({class_name:'ScheduleSortField',fields:{m_fieldId:{m_id:id},m_sortOrder:order,m_groupingFlags:0}});
 record.graph!.edges.push({source_object_index:1,pointer_offset:offset,target_object_index:n});
}
test('saved grouping uses field keys, not type IDs, and hidden fields remain usable',()=>{
 const {record,doc,a,b}=fixture([{id:10,extra:{m_hidden:true}},{id:11,source:1},{id:-1152353,source:2}]);
 sortRule(record,0);let p=reconstructSchedule(record,doc);
 assert.equal(p.rows.length,2);assert.equal(p.columns.length,2);assert.equal(p.all_columns.length,3);
 a.saved_metadata!.parameter_sets=[];value(a,10,'B');p=reconstructSchedule(record,doc);
 assert.equal(p.rows.length,1);assert.equal(p.rows[0].cells[1].value,2);
 p=reconstructSchedule(record,doc,{filters:[{field_id:'0',operator:'equal',value:'B'}]});assert.equal(p.passed_instances,2);
 b.saved_metadata!.parameter_sets=[];p=reconstructSchedule(record,doc);assert.equal(p.rows.length,2,'unknown key must not merge');
});
test('descending sort and itemization use saved rules; unresolved rules cannot collapse rows',()=>{
 const {record,doc}=fixture();sortRule(record,0,1);record.graph!.objects[1].fields.m_bInstanceSchedule=true;
 assert.deepEqual(reconstructSchedule(record,doc).rows.map(r=>r.element_ids[0]),['2','1']);
 record.graph!.objects[1].fields.m_bInstanceSchedule=false;sortRule(record,999);
 const p=reconstructSchedule(record,doc);assert.equal(p.rows.length,2);assert.equal(p.rule_audit.sorting.state,'unsupported');
});
test('filters retain unknowns, exclude confirmed failures and preserve every decision',()=>{
 const {record,doc}=fixture();const c=owner(3);doc.schedule_data!.records.push(c);
 const p=reconstructSchedule(record,doc,{grouping:'type',filters:[{field_id:'0',operator:'equal',value:'A'}],sum_fields:['2']});
 assert.equal(p.passed_instances,1);assert.equal(p.excluded_instances,1);assert.equal(p.unknown_instances,1);
 assert.equal(p.rows.length,2);assert.equal(p.totals[0].cell.value,1);
 assert.deepEqual(p.selection.map(d=>d.state),['pass','fail','unknown']);assert.equal(p.selection[1].filters[0].cell!.value,'B');
});
test('unreadable native filters make all surviving candidates unknown and block totals',()=>{
 const {record,doc}=fixture();record.graph!.objects[1].fields.m_filterArr=[{pointer_token:1,offset:987}];
 const p=reconstructSchedule(record,doc,{sum_fields:['2']});assert.equal(p.passed_instances,0);assert.equal(p.unknown_instances,2);assert.equal(p.totals[0].cell.state,'missing');
 assert.ok(p.rows.every(r=>r.membership==='unknown'));assert.match(previewCsv(p),/unsupported/);
 delete record.graph!.objects[1].fields.m_filterArr;assert.equal(reconstructSchedule(record,doc).unknown_instances,2,'unreadable array is not an empty array');
});
test('numeric filter checks units and zero; missing never passes negative predicates',()=>{
 const {record,doc,a,b}=fixture([{id:10}]);a.saved_metadata!.parameter_sets=[];b.saved_metadata!.parameter_sets=[];value(a,10,0,'Double');
 let p=reconstructSchedule(record,doc,{filters:[{field_id:'0',operator:'greater_equal',value:0,unit:'native'}]});
 assert.equal(p.passed_instances,1);assert.equal(p.unknown_instances,1);
 p=reconstructSchedule(record,doc,{filters:[{field_id:'0',operator:'not_equal',value:0,unit:'ft'}]});assert.equal(p.unknown_instances,2);
});
test('AND semantics: one confirmed failure excludes even when another condition is unknown',()=>{
 const {record,doc}=fixture();const p=reconstructSchedule(record,doc,{filters:[{field_id:'0',operator:'equal',value:'A'},{field_id:'missing',operator:'has_value'}]});
 assert.equal(p.excluded_instances,1);assert.equal(p.unknown_instances,1);assert.equal(p.passed_instances,0);
});
test('sums use instances before grouping; incomplete values and IDs cannot produce false totals',()=>{
 const {record,doc}=fixture();const p=reconstructSchedule(record,doc,{grouping:'type',sum_fields:['2','0']});
 assert.equal(p.rows.length,1);assert.equal(p.totals[0].cell.value,2);assert.equal(p.totals[1].cell.state,'unsupported');
 assert.equal(sumCells([{state:'value',value:3,storage_type:'ElementId',evidence:[]}]).state,'unsupported');
 assert.equal(sumCells([{state:'value',value:3,storage_type:'Double',unit:'ft',evidence:[]},{state:'value',value:3,storage_type:'Double',unit:'native',evidence:[]}]).state,'conflict');
 assert.equal(sumCells([{state:'value',value:Number.MAX_SAFE_INTEGER,storage_type:'Integer',evidence:[]},{state:'value',value:1,storage_type:'Integer',evidence:[]}]).state,'unsupported');
});
test('text predicates are explicit and case sensitive; reference IDs have no numeric order',()=>{
 const cell={state:'value' as const,value:'Door A',storage_type:'String',evidence:[]};
 for(const [operator,value,expected] of [['contains','Door','pass'],['begins','door','fail'],['ends','A','pass'],['not_contains','B','pass']] as const)assert.equal(evaluateFilter({field_id:'0',operator,value},cell).state,expected);
 assert.equal(evaluateFilter({field_id:'0',operator:'greater',value:1},{state:'value',value:2,storage_type:'ElementId',evidence:[]}).state,'unknown');
});
test('unsafe numeric element identities are excluded instead of joining rounded IDs',()=>{
 const {record,doc}=fixture();doc.schedule_data!.records.push(owner(Number.MAX_SAFE_INTEGER+1));const p=reconstructSchedule(record,doc);
 assert.equal(p.instance_count,2);assert.equal(p.unresolved_instances,1);
});
test('review settings survive serialization but cannot leak across source hashes or schedules',()=>{
 const settings={grouping:'type' as const,filters:[{field_id:'5',operator:'greater' as const,value:4,unit:'ft'}],sum_fields:['2']};
 const raw=writeScheduleSettings(settings,'a','50');assert.deepEqual(readScheduleSettings(raw,'a','50'),settings);
 assert.throws(()=>readScheduleSettings(raw,'b','50'));assert.throws(()=>readScheduleSettings(raw,'a','51'));assert.throws(()=>readScheduleSettings('{','a','50'));
 assert.throws(()=>readScheduleSettings(writeScheduleSettings({...settings,filters:[{field_id:'5',operator:'equal',value:Infinity}]},'a','50'),'a','50'));
});

test('multicategory schedule retains curves and resolves a saved type link without caption matching',()=>{
 const {record,doc,a,t}=fixture([{id:99}]);record.graph!.objects[1].fields.m_categoryId=-1;
 a.class_name='RbsDuctCurve';a.saved_metadata!.root_references={};a.root_fields={m_idType:100};
 value(t,99,'Inherited');const p=reconstructSchedule(record,doc);assert.equal(p.instance_count,2);
 assert.equal(p.rows[0].cells[0].value,'Inherited');assert.match(p.rows[0].cells[0].evidence[0].rule!,/type_reference/);
});
test('native filters follow explicit field links and retain unknown missing parameters',()=>{
 const {record,doc}=fixture();const schema=record.graph!.objects[1].fields;schema.m_filterArr=[{pointer_token:1,offset:900}];
 const n=record.graph!.objects.length;record.graph!.objects.push({class_name:'ScheduleFilter',fields:{m_fieldId:{m_id:0},m_filterType:2,m_value:{m_storageType:3,m_str:{m_str:'A'}}}});
 record.graph!.edges.push({source_object_index:1,pointer_offset:900,target_object_index:n});
 const unknown=owner(3);doc.schedule_data!.records.push(unknown);
 const p=reconstructSchedule(record,doc);assert.equal(p.passed_instances,1);assert.equal(p.excluded_instances,1);assert.equal(p.unknown_instances,1);assert.equal(p.rule_audit.native_filters.state,'interpreted_requires_review');
});

test('saved user workset names support text filters while integer filters use the exact partition ID',()=>{
 const {record,doc,a,b}=fixture([{id:-1002053}]);
 a.workset={status:'decoded',partition_id:10,name:'Supply',source:{stream:'Global/PartitionTable'}};
 b.workset={status:'decoded',partition_id:11,name:'Return',source:{stream:'Global/PartitionTable'}};
 const schema=record.graph!.objects[1].fields;schema.m_filterArr=[{pointer_token:1,offset:999}];const i=record.graph!.objects.length;
 const rule={m_fieldId:{m_id:0},m_filterType:8,m_value:{m_storageType:3,m_str:{m_str:'Supply'}}};
 record.graph!.objects.push({class_name:'ScheduleFilter',fields:rule});record.graph!.edges.push({source_object_index:1,pointer_offset:999,target_object_index:i});
 let p=reconstructSchedule(record,doc);assert.equal(p.passed_instances,1);assert.equal(p.excluded_instances,1);assert.equal(p.rows[0].cells[0].value,'Supply');
 Object.assign(rule,{m_filterType:2,m_value:{m_storageType:1,m_int:11} as any});p=reconstructSchedule(record,doc);assert.equal(p.passed_instances,1);assert.equal(p.rows[0].element_ids[0],'2');
});
