import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import {fileURLToPath} from 'node:url';

test('CAD bridge routes file/layer/object visibility through the CAD API and confirms state',async t=>{
 const win=new Window({url:'https://example.test/cad/'});t.after(()=>win.happyDOM.close());
 for(const name of ['document','location','File'])Object.defineProperty(globalThis,name,{value:win[name],writable:true,configurable:true});
 document.body.innerHTML='<div id="drawing"></div><div id="status"></div><select id="layers"></select><button id="fit"></button>';
 globalThis.Option=function(text,value){const option=document.createElement('option');option.textContent=text;option.value=value;return option;};
 const sent=[];globalThis.parent={postMessage:data=>sent.push(data)};let receive;
 globalThis.addEventListener=(name,handler)=>{assert.equal(name,'message');receive=handler;};
 const layers=[{name:'ОВ',isOff:false,isFrozen:false},{name:'АР',isOff:true,isFrozen:false}];
 const entities=[{objectId:'ABC',dxfTypeName:'LINE',layer:'ОВ'},{objectId:'DEF',dxfTypeName:'INSERT',layer:'АР'}];
 const visible=new Map([['ABC',true],['DEF',true]]),highlights=[];
 globalThis.__cadManager={curDocument:{database:{tables:{blockTable:{modelSpace:{newIterator:()=>entities.values()}},layerTable:{newIterator:()=>layers.values()}}}},
  curView:{getEntityVisible:id=>visible.get(id),setEntitySceneVisible:(id,shown)=>{if(!visible.has(id))return false;visible.set(id,shown);return true;},waitUntilIdle:async()=>{},highlight:ids=>highlights.push(ids),unhighlight:()=>{},zoomToFitDrawing:()=>{},stats:{summary:{entityCount:2}}},areWorkersReady:async()=>true,openDocument:async()=>true};
 const modules={
  '@mlightcad/cad-simple-viewer':'export class AcApDocManager {static createInstance(){} static get instance(){return globalThis.__cadManager}};export const acedApplyUiTheme=()=>{};',
  '@mlightcad/data-model':'export const AcDbDatabaseConverterManager={instance:{register(){}}};export const AcDbFileType={DWG:1};',
  '@mlightcad/libredwg-converter':'export class AcDbLibreDwgConverter{}',
  '@mlightcad/mtext-renderer':'export const FontManager={instance:{}};',
  '@mlightcad/three-renderer':'export const AcTrMTextRenderer={getInstance:()=>({setDefaultFonts:async()=>{}})};'
 };
 const result=await build({entryPoints:[fileURLToPath(new URL('../../integrations/cad-viewer/main.ts',import.meta.url))],bundle:true,write:false,format:'esm',loader:{'.css':'empty'},plugins:[{name:'cad-api-stubs',setup(build){build.onResolve({filter:/^@mlightcad\//},args=>({path:args.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'js'}));}}]});
 await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
 const command=async data=>receive({origin:location.origin,source:parent,data:{channel:'uvyazka-cad',job:'j1',...data}});
 assert.equal(sent.at(-1).kind,'ready');
 await command({kind:'open',file:new File(['fixture'],'model.dwg')});assert.equal(sent.at(-1).kind,'opened');assert.equal(sent.at(-1).tree.entities.length,2);
 await command({kind:'entity-visibility',id:'ABC',visible:false});assert.equal(sent.at(-1).kind,'tree-state');assert.equal(sent.at(-1).entities[0].visible,false);
 await command({kind:'all-layer-visibility',visible:true});assert.equal(visible.get('ABC'),false);assert.ok(layers.every(l=>!l.isOff));
 await command({kind:'entity-visibility',id:'ABC',visible:true});assert.equal(visible.get('ABC'),true);
 await command({kind:'isolate-layer',layer:'АР'});assert.equal(layers[0].isOff,true);assert.equal(layers[1].isOff,false);
 await command({kind:'select-entity',id:'DEF'});assert.deepEqual(highlights,[['DEF']]);assert.ok(sent.some(e=>e.kind==='entity-selected'&&e.entity.id==='DEF'));
 await command({kind:'reset-visibility'});assert.ok(layers.every(l=>!l.isOff&&!l.isFrozen));assert.ok([...visible.values()].every(Boolean));
 const count=sent.length;await command({kind:'layer-visibility',job:'other',layer:'АР',visible:false});assert.equal(sent.length,count);
 await receive({origin:'https://foreign.test',source:parent,data:{channel:'uvyazka-cad',kind:'reset-visibility',job:'j1'}});assert.equal(sent.length,count);
});
