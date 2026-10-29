import test from 'node:test';
import assert from 'node:assert/strict';
import {importRvtDirect,sameReadSource} from '../src/browser-rvt-direct.ts';
import {elementIdentity} from '../src/element-identity.ts';
import {modelCoverage} from '../src/model-coverage.ts';
import {physicalRow} from '../src/gost-specification.ts';

function fixture(){
 const bytes=new Uint8Array(48);new Float32Array(bytes.buffer,0,9).set([0,0,0,1,0,0,0,1,0]);new Uint32Array(bytes.buffer,36,3).set([0,1,2]);
 return {geometry_binary:bytes,manifest:{contract:'RvtDirectScene',version:1,units:'metres',revit_version:2024,complete_document_geometry:false,render_origin_m:[0,0,0],bounds_min_m:[0,0,0],bounds_max_m:[1,1,0],elements:[{element_id:'9007199254740993',unique_id:'synthetic-exact-id',status:'decoded_saved_graphics',source:{stream:'synthetic/graphics',body_sha256:'b'.repeat(64)},metadata:{class_name:'FamilyInstance',root_fields:{m_name:'Синтетический насос'},saved_metadata:{parameter_sets:[{parameters:[{serialized_parameter_id:42,storage_type:'Double',raw_value:7.5}]}]}},mesh:{bbox_min_m:[0,0,0],bbox_max_m:[1,1,0],vertex_count:3,index_count:3,position_byte_offset:0,index_byte_offset:36,representation_id:0,groups:[{start:0,count:3,material_index:0}],styles:[{name:'Синтетический материал',color:[0.2,0.4,0.6],opacity:1}],source:{kind:'derived',method:'synthetic',version:'1',representation_id:0}}}],parameter_definitions:{42:{parameter_id:42,caption:'Тестовое значение'}}}};
}
const source={filename:'synthetic.rvt',sha256:'a'.repeat(64),size_bytes:1024};
test('direct RVT preserves exact identity and raw parameters without IFC or physical counts',async()=>{
 const {model,binary}=await importRvtDirect(fixture(),source),e=model.elements[0];
 assert.equal(elementIdentity(e).element_id,'9007199254740993');assert.equal(elementIdentity(e).unique_id,'synthetic-exact-id');
 assert.equal(e.property_sets['Параметры RVT · сохранённые значения']['Тестовое значение [42]'],7.5);
 assert.equal(model.source.rvt_read_mode,'direct');assert.equal(model.source.conversion,undefined);assert.equal(model.source.exported_at,'');assert.equal(binary.byteLength,48);
 assert.equal(model.statistics.physical_elements,0);assert.equal(e.geometry_evidence?.quantity_eligible,false);
 assert.equal(physicalRow({key:e.id,name:e.name,source_sha256:source.sha256,scene_id:e.id,element:e}),false);
 assert.equal(modelCoverage(model).find(c=>c.key==='geometry')?.status,'partial');
});
test('direct RVT has a deterministic package ID distinct from IFC mode for the same source',async()=>{
 const a=await importRvtDirect(fixture(),source),b=await importRvtDirect(fixture(),source);
 assert.equal(a.model.model_id,b.model.model_id);assert.notEqual(a.model.model_id,source.sha256);
 assert.equal(sameReadSource(a.model,source.sha256,'direct'),true);assert.equal(sameReadSource(a.model,source.sha256,'ifc'),false);
});
test('direct RVT rejects corrupt ranges, indices, duplicate IDs and empty graphics',async()=>{
 const bad=fixture();bad.manifest.elements[0].mesh.index_byte_offset=40;await assert.rejects(importRvtDirect(bad,source));
 const badIndex=fixture();new Uint32Array(badIndex.geometry_binary.buffer,36,3)[2]=99;await assert.rejects(importRvtDirect(badIndex,source),/индексы/);
 const duplicate=fixture();duplicate.manifest.elements.push(duplicate.manifest.elements[0]);await assert.rejects(importRvtDirect(duplicate,source),/повторный/);
 const empty=fixture();empty.manifest.elements=[];await assert.rejects(importRvtDirect(empty,source),/IFC автоматически не использовался/);
});
