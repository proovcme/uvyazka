// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic values only; no private drawing content.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transportSafeMetadata,metadataEntity} from './read-data.mjs';
import {createHash} from 'node:crypto';

test('valid Cyrillic, supplementary characters, scalars and big integers survive',()=>{
 const source={name:'Лестница 😀',pair:'\ud83d\ude00',empty:'',zero:0,none:null,flag:false,big:9007199254740993n};
 const diagnostics=[];
 const result=transportSafeMetadata(source,diagnostics);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{...source,big:'9007199254740993'});
 assert.deepEqual(diagnostics,[]);
});

test('lone units remain addressable and recoverable without invalid transport strings',()=>{
 const damaged='A\ude53B\ud800\ud800😀\udfff';
 const source={sections:{elements:[{handle:'A1',xdata:[{value:damaged},{value:'\\ude53'}]}]}};
 const diagnostics=[];
 const result=transportSafeMetadata(source,diagnostics);
 assert.equal(result.sections.elements[0].xdata[0].value,'A\\ude53B\\ud800\\ud800😀\\udfff');
 assert.equal(result.sections.elements[0].xdata[1].value,'\\ude53');
 assert.equal(diagnostics.length,1);
 assert.deepEqual(diagnostics[0].path,['sections','elements',0,'xdata',0,'value']);
 assert.equal(JSON.parse(diagnostics[0].original_json),damaged);
 const walk=value=>{
  if(typeof value==='string')assert.ok(value.isWellFormed());
  else if(value&&typeof value==='object')Object.values(value).forEach(walk);
 };
 walk(JSON.parse(JSON.stringify({result,diagnostics})));
 assert.equal(source.sections.elements[0].xdata[0].value,damaged);
});

test('invalid property keys fail explicitly instead of colliding or changing addresses',()=>{
 assert.throws(()=>transportSafeMetadata({'\ude53':1,'\\ude53':2},[]),/invalid UTF-16 property key/);
 const result=transportSafeMetadata(JSON.parse('{"__proto__":{"x":1}}'),[]);
 assert.equal(Object.getPrototypeOf(result),null);
 assert.equal(result.__proto__.x,1);
});

test('opaque OLE is represented explicitly without discarding the entity or mutating the decoder',()=>{
 const entity={type:'OLE2FRAME',handle:'AA',dataSize:3,binaryData:'00ABCD',leftUpPoint:{x:1,y:2}};
 const diagnostics=[];
 const result=metadataEntity(entity,diagnostics,4);
 assert.equal(result.handle,'AA');
 assert.deepEqual(result.leftUpPoint,{x:1,y:2});
 assert.equal(result.binaryData.state,'not_decoded');
 assert.equal(result.binaryData.declared_size_bytes,3);
 assert.equal(result.binaryData.serialized_sha256,createHash('sha256').update(JSON.stringify('00ABCD')).digest('hex'));
 assert.deepEqual(diagnostics[0].path,['sections','elements',4,'binaryData']);
 assert.equal(entity.binaryData,'00ABCD');
 const line={type:'LINE',binaryData:'not an OLE field'};
 assert.equal(metadataEntity(line,diagnostics,5),line);
 assert.equal(diagnostics.length,1);
});
