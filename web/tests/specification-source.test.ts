import test from 'node:test';import assert from 'node:assert/strict';
import {specificationSourceContext} from '../src/specification-source.ts';
import type {SpecDataset} from '../src/model-specification.ts';
test('source labels keep equal owner IDs in different files separate and attribute a type only to its parameter source',()=>{
 const a='a'.repeat(64),b='b'.repeat(64);
 const rows=[a,b].map((hash,i)=>({key:String(i),source_sha256:hash,native:{identity:{element_id:1}},type:{identity:{element_id:100}},document:{source:{filename:i?'b.rvt':'a.rvt'}}}));
 const dataset={rows,model:null} as unknown as SpecDataset,cell={state:'value' as const,value:'Test',evidence:[{owner_id:'100',path:[],value:'Test',storage_type:'String',location:{}}]};
 const labels=specificationSourceContext(dataset,['0','1'],cell,a);assert.deepEqual(labels.sources,['a.rvt','b.rvt']);assert.equal(labels.owners.filter(o=>o.label.includes('типа')).length,1);assert.match(labels.owners.find(o=>o.label.includes('типа'))!.label,/a.rvt/);assert.equal(labels.owners.filter(o=>o.id==='1').length,2);
});
