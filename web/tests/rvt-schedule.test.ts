import test from 'node:test';
import assert from 'node:assert/strict';
import {reconstructSchedule,previewValue,previewCsv} from '../src/rvt-schedule.ts';
import type {ParameterRecord} from '../src/rvt-schedule.ts';
import type {NativeRecord,RvtDocument} from '../src/rvt-document.ts';

function owner(id:number,kind='FamilyInstance',category=-2000023,type=100):ParameterRecord {
 return {identity:{element_id:id},class_name:kind,status:'complete_bounded_graph',source:{body_sha256:'body-'+id},saved_metadata:{root_references:{m_masterSymbolId:type},raw_field_parameters:[{parameter_id:-1140363,storage_type:'ElementId',raw_value:category}],parameter_sets:[],resolved_family_parameters:[],family_parameter_slots:[]}};
}
function value(r:ParameterRecord,id:number,raw:unknown,storage='String') {r.saved_metadata!.parameter_sets.push({parameters:[{serialized_parameter_id:id,storage_type:storage,raw_value:raw}]});}
function fixture(fields:{id:number;source?:number;extra?:any}[]=[{id:10},{id:11,source:1},{id:-1152353,source:2}]){
 const record:NativeRecord={identity:{element_id:50},class_name:'DBViewSchedule',kind:'schedule',status:'complete_bounded_graph',source:{},graph:{objects:[{class_name:'DBViewSchedule',fields:{m_pSchema:{offset:1,pointer_token:1}}},{class_name:'ScheduleSchema',fields:{m_categoryId:-2000023,m_fieldIds:fields.map((_,i)=>({m_id:i})),m_pFields:fields.map((_,i)=>({offset:i+10,pointer_token:1}))}}],edges:[{source_object_index:0,pointer_offset:1,target_object_index:1}]}};
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
