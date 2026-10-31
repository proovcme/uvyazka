import test from 'node:test';import assert from 'node:assert/strict';
import {encodeSharedJson,decodeSharedJson} from '../src/shared-json.ts';
test('repeated immutable metadata retains exact values, identifiers, units and own dangerous-looking keys',()=>{
 const value=JSON.parse('{"__proto__":{"polluted":true},"ID":"9007199254740993","zero":0,"empty":"","missing":null,"unit":"m"}');
 const input={one:value,two:structuredClone(value),array:[true,null,0,'',undefined],omitted:undefined};
 const encoded=encodeSharedJson(input),decoded:any=decodeSharedJson(JSON.parse(JSON.stringify(encoded)));
 assert.deepEqual(decoded,JSON.parse(JSON.stringify(input)));assert.equal(decoded.one,decoded.two);assert.equal(decoded.one.ID,'9007199254740993');assert.equal(({} as any).polluted,undefined);
});
test('many duplicated property groups and evidence strings are stored once without discarding evidence',()=>{
 const note='Синтетическое описание '.repeat(100),rows=Array.from({length:500},()=>({properties:{name:note,power:0,unit:'W'},evidence:{path:['synthetic','value'],value:note}}));
 const encoded=JSON.stringify(encodeSharedJson(rows));assert.ok(encoded.length<JSON.stringify(rows).length/30);
 assert.deepEqual(decodeSharedJson(JSON.parse(encoded)),rows);
});
test('cycles, invalid references and duplicate keys are rejected instead of creating mutable cyclic model graphs',()=>{
 const cyclic:any={};cyclic.self=cyclic;assert.throws(()=>encodeSharedJson(cyclic),/Циклическая/);
 const encoded:any=encodeSharedJson({one:1});encoded.root=[0,999];assert.throws(()=>decodeSharedJson(encoded),/ссылка/);
 const bad:any={contract:'UvyazkaSharedJson',version:1,root:[0,0],nodes:[['a',[[0,0]]]],strings:[]};assert.throws(()=>decodeSharedJson(bad),/Циклическая/);
 bad.nodes=[['o',[[0,1],[0,2]]]];bad.strings=['same'];assert.throws(()=>decodeSharedJson(bad),/Повторный/);
});
