// SPDX-License-Identifier: GPL-3.0-or-later
// CSP-compatible closures replacing two Emscripten dynamic-code factories.
// Pinned to the shipped LibreDWG worker; fail closed when its shape changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file='dist/assets/libredwg-parser-worker.js';
let source=readFileSync(file,'utf8');
if(createHash('sha256').update(source).digest('hex')!=='267d99826f8619d8bddb3934fc2863bd83ffbd9b0f8f851847e7c60780dfd577')throw Error('Unexpected LibreDWG worker checksum');
function replaceBetween(start,end,replacement){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  if(a<0||b<0||source.indexOf(start,a+start.length)>=0)throw Error('Unexpected LibreDWG glue version');
  source=source.slice(0,a)+replacement+source.slice(b);
}
replaceBetween('function Vr(e,r,o,s){','function Hr(',`function Vr(e,r,o,s){
  const count=e.length-2,needsDestructors=kn(e);
  return function(humanName,throwBindingError,invoker,fn,runDestructors,fromRetWire,toClassParamWire,...converters){
    return function(...args){
      const destructors=needsDestructors?[]:null,wired=[];
      for(let i=0;i<count;i++)wired.push(converters[i](destructors,args[i]));
      const result=invoker(fn,...wired);
      if(needsDestructors)runDestructors(destructors);
      else for(let i=0;i<count;i++)if(e[i+2].destructorFunction!==null)e[i+2].destructorFunction(wired[i]);
      return o?fromRetWire(result):undefined;
    };
  };
}`);
replaceBetween('la=function(e,r,o){',';function ca(',`la=function(e,r,o){
  r>>>=0;const [resultType,...argTypes]=sa(e,r);
  const read=argTypes.map(t=>t.readValueFromPointer.bind(t));
  const toWire=resultType.toWireType.bind(resultType);
  const caller=function(handle,methodName,destructorsRef,args){
    const values=read.map((reader,i)=>reader(args+i*8));let result;
    switch(o){
      case 0:result=Pt.toValue(handle)(...values);break;
      case 1:{const owner=Pt.toValue(handle);result=owner[Bn(methodName)](...values);break;}
      case 2:result=Reflect.construct(Pt.toValue(handle),values);break;
      case 3:result=values.at(-1);break;
      default:throw Error('Unsupported emval call kind '+o);
    }
    return resultType.isVoid?undefined:_a(toWire,destructorsRef,result);
  };
  return oa(ze('methodCaller',caller));
}`);
if(/new Function|\beval\(/.test(source))throw Error('Dynamic JavaScript remains in worker');
writeFileSync(file,source);
