import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {fixture} from './reliability-fixture.ts';
import {rvtModelCache,rvtCacheKey,validateCachedRvt} from '../src/rvt-model-cache.ts';
import type {CachedRvtModel} from '../src/rvt-model-cache.ts';
import type {RvtMode} from '../src/browser-rvt-direct.ts';

function sample(mode:RvtMode='ifc',hash='b'.repeat(64)):CachedRvtModel{
 const {model,binary}=fixture();model.source={...model.source,format:'rvt',filename:'synthetic.rvt',sha256:hash,rvt_read_mode:mode};
 model.importer_version=mode==='direct'?'uvyazka-rvt-direct-v1':'web-ifc-0.0.78/uvyazka-2';
 if(mode==='direct')model.rvt_direct={experimental:true,complete_document_geometry:false,graphics_owners:1,observed_records:1,unrendered_records:0,partial_owners:0,metadata_error:null};
 return {model,binary,document:{schema_version:1,schema_sha256:'synthetic',status:'partial',records:[],clipped_records:0,summary:{},source:{filename:'synthetic.rvt',sha256:hash,size_bytes:100},evaluated_schedule_body_available:false},conversion:{status:'synthetic'},convertedIfc:new Uint8Array([1,2,3]).buffer};
}
test('RVT cache separates readers and rejects wrong provenance or truncated payloads',()=>{
 const hash='b'.repeat(64),value=sample();
 assert.notEqual(rvtCacheKey(hash,'ifc'),rvtCacheKey(hash,'direct'));
 assert.notEqual(rvtCacheKey(hash,'ifc'),rvtCacheKey('c'.repeat(64),'ifc'));
 validateCachedRvt(value,hash,'ifc');
 assert.throws(()=>validateCachedRvt(value,hash,'direct'));
 assert.throws(()=>validateCachedRvt(value,'c'.repeat(64),'ifc'));
 assert.throws(()=>validateCachedRvt({...value,binary:new ArrayBuffer(0)},hash,'ifc'));
 const wrong=sample();wrong.document!.source!.sha256='c'.repeat(64);assert.throws(()=>validateCachedRvt(wrong,hash,'ifc'));
});
test('repeat RVT opening restores both geometry and partial document, retaining IFC export',async()=>{
 globalThis.indexedDB=new IDBFactory();const cache=await rvtModelCache();
 try{
  const hash='b'.repeat(64),value=sample();await cache.put(hash,'ifc',value);
  const restored=await cache.get(hash,'ifc');assert.deepEqual(restored,value);
  assert.equal(await cache.get(hash,'direct'),undefined);
  await cache.put(hash,'direct',sample('direct'));assert.ok((await cache.get(hash,'direct'))?.model.rvt_direct);
  assert.equal((await cache.get(hash,'ifc'))?.model.rvt_direct,undefined);
  await cache.clear();assert.equal(await cache.get(hash,'ifc'),undefined);
 }finally{cache.close();}
});
test('RVT cache retains three recently used packages without loading all geometry for eviction',async t=>{
 globalThis.indexedDB=new IDBFactory();let time=100;t.mock.method(Date,'now',()=>++time);
 const cache=await rvtModelCache();
 try{
  for(const hash of ['a','b','c'])await cache.put(hash,'ifc',sample('ifc',hash));
  await cache.get('a','ifc');await cache.put('d','ifc',sample('ifc','d'));
  assert.equal(await cache.get('b','ifc'),undefined);assert.ok(await cache.get('a','ifc'));assert.ok(await cache.get('c','ifc'));assert.ok(await cache.get('d','ifc'));
 }finally{cache.close();}
});
