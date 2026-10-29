import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './reliability-fixture.ts';import {geometryQuality} from '../src/geometry-quality.ts';import {modelCoverage} from '../src/model-coverage.ts';
test('rendered bounds cannot imply a fully read or measured RVT shape',()=>{
 const {model}=fixture(),e=model.elements[0];e.geometry_evidence={engine:'rvt-rs',body_source:'partition_element_record_bbox',status:'bounding_box',quantity_eligible:false,requires_review:true,reason:'synthetic'};
 assert.equal(geometryQuality(e)?.kind,'bounds');assert.match(geometryQuality(e)!.message,/Точная форма не прочитана/);
 const coverage=modelCoverage(model).find(row=>row.key==='geometry')!;assert.equal(coverage.status,'partial');assert.match(coverage.detail,/габаритных блоков: 1/);
 assert.equal(model.statistics.physical_elements,1);assert.equal(e.geometry_evidence.quantity_eligible,false);
});
test('saved graphics and reconstruction have explicit separate quality labels; plain IFC is unchanged',()=>{
 const {model}=fixture(),e=model.elements[0];assert.equal(geometryQuality(e),null);
 e.geometry_evidence={engine:'rvt-rs',body_source:'partition_wall_centreline',status:'decoded_approximation',quantity_eligible:true,requires_review:true,reason:'synthetic'};
 assert.equal(geometryQuality(e)?.kind,'reconstructed');assert.equal(modelCoverage(model)[0].status,'partial');
 e.geometry_evidence.engine='rvt_native_saved_graphics';assert.equal(geometryQuality(e)?.kind,'saved');
});
