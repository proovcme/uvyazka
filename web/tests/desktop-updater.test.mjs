import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {Window} from 'happy-dom';import {build} from 'esbuild';
const bundle=await build({entryPoints:['../desktop/ui/app.js'],bundle:true,format:'esm',write:false,plugins:[{name:'tauri-fixture',setup(b){b.onResolve({filter:/^@tauri-apps\//},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(...a)=>globalThis.desktopQA.invoke(...a);export const check=()=>globalThis.desktopQA.check();export const relaunch=()=>globalThis.desktopQA.relaunch();'}));}}]});
const html=await readFile('../desktop/ui/index.html','utf8');
let serial=0;
async function fixture(t,mode){
 const win=new Window({url:'http://tauri.localhost'});t.after(()=>win.happyDOM.close());globalThis.document=win.document;document.write(html);
 const calls=[];const mock={invoke:async command=>{calls.push(command);return {url:'http://127.0.0.1:17881/',version:'0.4.0-alpha.0'};},check:async()=>({version:'0.4.0-alpha.1',body:'Synthetic release',download:async cb=>{calls.push('download');cb({event:'Started',data:{}});cb({event:'Progress',data:{chunkLength:1024}});if(mode==='signature')throw Error('Invalid update signature');},install:async()=>{calls.push('install');if(mode==='installer')throw Error('Installer failed');}}),relaunch:async()=>calls.push('relaunch')};
 globalThis.desktopQA=mock;globalThis.fetch=async url=>({ok:!(mode==='backup'&&String(url).endsWith('/backup')),json:async()=>{
  if(String(url).endsWith('/update-ready'))return {ready:mode!=='busy',reason:'An active project job must finish',token:'synthetic-token'};
  calls.push('backup');return mode==='backup'?{error:'A new job started during download'}:{path:'synthetic-backup'};
 }});
 await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64')+'#qa'+serial++);
 const settle=()=>new Promise(r=>setTimeout(r,10));await settle();document.getElementById('updates').click();await settle();
 [...document.querySelectorAll('button')].find(b=>b.textContent==='Скачать и установить').click();await settle();
 return {calls,body:document.getElementById('settings-body').textContent};
}
for(const mode of ['busy','signature','backup'])test('update '+mode+' leaves the running core and its jobs untouched',async t=>{const {calls}=await fixture(t,mode);assert.equal(calls.includes('stop_backend'),false);assert.equal(calls.includes('install'),false);assert.equal(document.getElementById('close-settings').disabled,false);});
test('installation failure restarts a core only after the maintenance backup succeeded',async t=>{const {calls,body}=await fixture(t,'installer');assert.deepEqual(calls,['start_backend','download','backup','stop_backend','install','stop_backend','start_backend']);assert.match(body,/Installer failed/);});
test('successful update backs up before stopping, then installs and relaunches; unknown length is indeterminate',async t=>{const {calls}=await fixture(t,'success');assert.deepEqual(calls,['start_backend','download','backup','stop_backend','install','relaunch']);assert.equal(document.querySelector('progress').hasAttribute('value'),false);});
