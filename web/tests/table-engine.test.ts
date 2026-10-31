import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {build,describe} from '../src/table-engine.ts';
const hash='a'.repeat(64);
const input:any={documents:[{schema_version:1,source:{filename:'synthetic.rvt',sha256:hash,size_bytes:100},records:[],status:'read',schedule_data:{source_sha256:hash,status:'read',scope:['FamilyInstance'],records:[1,2,3].map(id=>({identity:{element_id:id},class_name:'FamilyInstance',status:'read',source:{stream:'synthetic'},saved_metadata:{parameter_sets:[{parameters:[{serialized_parameter_id:-1001301,raw_value:id===3?null:id,storage_type:'Double'},{serialized_parameter_id:-1140363,raw_value:-2001140,storage_type:'ElementId'}]}]}}))}}]};
test('embedded bundle and GUI modules produce identical tables without a DOM',()=>{
 const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../../src/uvyazka/resources/table-engine.js',import.meta.url),'utf8'),context);
 const schema=describe(input);assert.deepEqual(JSON.parse(JSON.stringify(context.UvyazkaTables.describe(input))),schema);
 const definition=schema.default_definition,field=schema.columns.find(c=>c.parameter_id==='-1001301'&&c.scope==='instance')!;
 definition.columns.push({id:field.id,label:'Ширина',aggregate:'sum'});definition.filters=[{field_id:field.id,operator:'greater',value:1,unit:'ft'}];
 const request={...input,definition};const expected=build(request),actual=JSON.parse(JSON.stringify(context.UvyazkaTables.build(request)));
 assert.deepEqual(actual,JSON.parse(JSON.stringify(expected)));assert.equal(actual.report.coverage.passed,1);assert.equal(actual.report.coverage.unknown,1);
 assert.equal(actual.report.rows[0].cells[2].value,'2');
});
