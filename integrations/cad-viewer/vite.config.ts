import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
export default defineConfig({base:'./',build:{chunkSizeWarningLimit:6000},plugins:[{
  name:'local-cad-workers',closeBundle(){
    const out=path.resolve('dist/assets');mkdirSync(out,{recursive:true});
    for(const [pkg,file] of [['cad-simple-viewer','mtext-renderer-worker.js'],['libredwg-converter','libredwg-parser-worker.js'],['libredwg-converter','libredwg-web.wasm']])
      copyFileSync(`node_modules/@mlightcad/${pkg}/dist/${file}`,path.join(out,file));
  }
}]});
