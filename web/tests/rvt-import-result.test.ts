import test from 'node:test';
import assert from 'node:assert/strict';
import {rvtImportFailure,hasReadableDocument,rvtDocumentIncomplete,validateRvtContainer,RVT_CONTAINER_ERROR} from '../src/rvt-import-result.ts';
import type {RvtDocument} from '../src/rvt-document.ts';
const doc=(readable=false):RvtDocument=>({schema_version:1,schema_sha256:'s',status:'partial',clipped_records:0,summary:null,evaluated_schedule_body_available:false,records:readable?[{identity:{element_id:1},class_name:'DBViewPlan',kind:'view',status:'complete_bounded_graph',source:{},graph:{objects:[{class_name:'DBViewPlan',fields:{}}],edges:[]}}]:[]});
test('renamed and truncated files fail before loading RVT runtime, with a specific message',()=>{
 assert.throws(()=>validateRvtContainer(new Uint8Array([0xd0,0xcf])),/CFB/);
 assert.throws(()=>validateRvtContainer(new TextEncoder().encode('not an RVT file')),/CFB/);
 assert.doesNotThrow(()=>validateRvtContainer(new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])));
 assert.equal(rvtImportFailure(RVT_CONTAINER_ERROR,null,null).message,RVT_CONTAINER_ERROR);
});
test('geometry success cannot hide missing or clipped native RVT data',()=>{
 assert.equal(rvtDocumentIncomplete(null),true);assert.equal(rvtDocumentIncomplete(doc()),true);
 const complete={...doc(),status:'complete',schedule_data:{source_sha256:'s',status:'complete',scope:[],records:[]}};
 assert.equal(rvtDocumentIncomplete(complete),false);
 assert.equal(rvtDocumentIncomplete({...complete,clipped_records:1}),true);
 assert.equal(rvtDocumentIncomplete({...complete,schedule_data:{...complete.schedule_data,clipped_records:1}}),true);
});
test('Revit 2021 framing failure explains compatibility instead of an IFC scaffold error',()=>{
 const d=doc();d.error='native record framing is unvalidated for Revit 2021';
 const conversion={diagnostics:{input:{revit_version:2021},exported:{building_elements:0}}};
 const result=rvtImportFailure('no validated typed IFC elements',d,conversion);
 assert.equal(result.kind,'error');assert.match(result.message,/RVT 2021/);assert.match(result.message,/не поддерживает/);assert.equal(result.details.readable_document,false);assert.equal(result.details.raw_message,'no validated typed IFC elements');assert.equal(result.details.conversion,conversion);
});
test('readable document survives geometry failure without declaring geometry success',()=>{
 const result=rvtImportFailure('unreachable',doc(true),null);
 assert.equal(result.kind,'partial');assert.match(result.message,/3D-геометрия не получена/);assert.match(result.message,/Симуляция недоступна/);assert.equal(result.details.readable_document,true);
});
test('empty or clipped catalogue does not become a successfully opened document',()=>{
 const empty=doc();assert.equal(hasReadableDocument(empty),false);
 const clipped=doc(true);clipped.records[0].graph=null;assert.equal(hasReadableDocument(clipped),false);
 assert.equal(rvtImportFailure('broken CFB',null,null).kind,'error');assert.equal(rvtImportFailure('no validated typed IFC elements',empty,null).kind,'error');
});
