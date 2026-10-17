import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),cache=new URL('.uvyazka-build/cad-test/',root);await mkdir(cache,{recursive:true});
const wasm=await readFile(new URL('integrations/cad-viewer/dist/assets/libredwg-web.wasm',root));
// Exercise parser code only, without any browser or UI automation.
globalThis.process=undefined;globalThis.WorkerGlobalScope=class {};globalThis.self={};
globalThis.fetch=async()=>new Response(wasm,{headers:{'Content-Type':'application/wasm'}});
const versions=[];
for(const [label,path] of [['original','node_modules/@mlightcad/libredwg-converter/dist/libredwg-parser-worker.js'],['hardened','dist/assets/libredwg-parser-worker.js']]){
 let code=await readFile(new URL('integrations/cad-viewer/'+path,root),'utf8');
 if(label==='hardened'&&/new Function|\beval\(/.test(code))throw Error('Dynamic code remains');
 code=code.replace('new Si;',';').replaceAll('import.meta.url','"http://localhost/libredwg-parser-worker.js"')+'\nexport {Ri};';
 const module=new URL(label+'.mjs',cache);await writeFile(module,code);versions.push((await import(module.href)).Ri);
}
for(const name of ['PolyLine2D.dwg','2018-Line.dwg','2000-Line.dwg','2000-Text.dwg']){
 const bytes=await readFile(new URL('.uvyazka-build/browser-fixtures/'+name,root));
 const input=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),results=[];
 for(const parse of versions)results.push(await parse(input));
 const digests=results.map(v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'));
 if(digests[0]!==digests[1])throw Error('Parser changed: '+name);
 console.log(JSON.stringify({file:name,equal:true,entities:results[1].database.entities.length,types:[...new Set(results[1].database.entities.map(e=>e.type))]}));
}
