import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './reliability-fixture.ts';
import {attachNativeIdentities} from '../src/rvt-native-identity.ts';
import type {RvtDocument} from '../src/rvt-document.ts';
function sample(){
 const {model}=fixture(),hash=model.source.sha256;model.source.format='rvt';
 model.elements[0].revit={element_id:'9007199254740993',phase_status:'not_read',id_basis:'rvt_converter_tag'};
 const document:RvtDocument={schema_version:1,schema_sha256:'synthetic',status:'partial',clipped_records:0,records:[],summary:{},evaluated_schedule_body_available:false,source:{sha256:hash,filename:'synthetic.rvt',size_bytes:100},schedule_data:{source_sha256:hash,status:'partial',scope:[],records:[{identity:{element_id:'9007199254740993',unique_id:'synthetic-native-unique-id',row_offset:42},class_name:'FamilyInstance',status:'partial',source:{stream:'Partitions/1',body_sha256:'synthetic'}}]}};
 return {model,document,hash};
}
test('native UniqueId joins by exact source and large ElementId, preserving evidence without promoting quantities',()=>{
 const {model,document,hash}=sample();attachNativeIdentities(model,document,hash);
 assert.equal(model.elements[0].revit?.unique_id,'synthetic-native-unique-id');assert.equal(model.elements[0].revit?.identity_source?.identity_row_offset,42);
 assert.equal(model.elements[0].revit?.element_id,'9007199254740993');assert.equal(model.elements[0].revit?.phase_status,'not_read');
 assert.equal(model.statistics.physical_elements,1);
});
test('native identity matching rejects another revision, duplicates and unsafe numeric IDs',()=>{
 const wrong=sample();wrong.document.schedule_data!.source_sha256='wrong';attachNativeIdentities(wrong.model,wrong.document,wrong.hash);assert.equal(wrong.model.elements[0].revit?.unique_id,undefined);
 const duplicate=sample();duplicate.document.schedule_data!.records.push(duplicate.document.schedule_data!.records[0]);attachNativeIdentities(duplicate.model,duplicate.document,duplicate.hash);assert.equal(duplicate.model.elements[0].revit?.unique_id,undefined);
 const unsafe=sample();unsafe.document.schedule_data!.records[0].identity.element_id=9007199254740993;attachNativeIdentities(unsafe.model,unsafe.document,unsafe.hash);assert.equal(unsafe.model.elements[0].revit?.unique_id,undefined);
 const split=sample();split.model.elements.push({...split.model.elements[0],id:'another-scene-id'});attachNativeIdentities(split.model,split.document,split.hash);assert.equal(split.model.elements[0].revit?.unique_id,undefined);
});
test('conflicting existing UniqueId is retained and reported instead of silently replaced',()=>{
 const {model,document,hash}=sample();model.elements[0].revit!.unique_id='previous-unique-id';attachNativeIdentities(model,document,hash);
 assert.equal(model.elements[0].revit?.unique_id,'previous-unique-id');assert.match(model.diagnostics.at(-1)!.message,/Conflicting/);
});
