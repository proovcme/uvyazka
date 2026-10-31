import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
// V8 has no DOM structuredClone. All table contracts contain plain JSON data.
const clone=`globalThis.structuredClone ??= value => {if(Array.isArray(value))return value.map(structuredClone);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,structuredClone(v)]));return value;};`;
const license=readFileSync(new URL('./node_modules/fflate/LICENSE',import.meta.url),'utf8');
await build({entryPoints:[fileURLToPath(new URL('./src/table-engine.ts',import.meta.url))],outfile:fileURLToPath(new URL('../src/uvyazka/resources/table-engine.js',import.meta.url)),bundle:true,format:'iife',globalName:'UvyazkaTables',platform:'neutral',target:'es2022',minify:true,legalComments:'eof',banner:{js:'// Generated from web/src/table-engine.ts. Apache-2.0; fflate MIT notice below.\n'+clone},footer:{js:'/* fflate 0.8.3\n'+license+'*/'}});
