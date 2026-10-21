import test from 'node:test';
import assert from 'node:assert/strict';
import {rvtImportFailure,hasReadableDocument} from '../src/rvt-import-result.ts';
import type {RvtDocument} from '../src/rvt-document.ts';
const doc=(readable=false):RvtDocument=>({schema_version:1,schema_sha256:'s',status:'partial',clipped_records:0,summary:null,evaluated_schedule_body_available:false,records:readable?[{identity:{element_id:1},class_name:'DBViewPlan',kind:'view',status:'complete_bounded_graph',source:{},graph:{objects:[{class_name:'DBViewPlan',fields:{}}],edges:[]}}]:[]});
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
