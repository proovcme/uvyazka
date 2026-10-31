import test from 'node:test';import assert from 'node:assert/strict';import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {fixture} from './reliability-fixture.ts';import {packWorkspace,unpackWorkspace} from '../src/workspace-archive.ts';
const hash=async(bytes:Uint8Array)=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
test('compact version 2 preserves values, source IDs, geometry and shared metadata; old version 1 still opens',async()=>{
 const original=fixture(),group={description:'Учебная строка '.repeat(30),zero:0,empty:'',id:'9007199254740993'};
 original.model.elements[0].property_sets={one:group,two:structuredClone(group)};
 const archive=await packWorkspace(original),files=unzipSync(archive),manifest=JSON.parse(strFromU8(files['manifest.json']));assert.equal(manifest.version,2);
 const restored=await unpackWorkspace(archive);assert.deepEqual(restored.model,JSON.parse(JSON.stringify(original.model)));assert.deepEqual(new Uint8Array(restored.binary),new Uint8Array(original.binary));assert.equal(restored.model.elements[0].property_sets.one,restored.model.elements[0].property_sets.two);
 delete files['models.json'];delete manifest.files['models.json'];const name=`models/${original.model.model_id}.json`;files[name]=strToU8(JSON.stringify(original.model));manifest.version=1;manifest.files[name]=await hash(files[name]);files['manifest.json']=strToU8(JSON.stringify(manifest));
 const legacy=await unpackWorkspace(zipSync(files));assert.deepEqual(legacy.model,JSON.parse(JSON.stringify(original.model)));assert.deepEqual(legacy.state,restored.state);
});
