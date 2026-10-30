import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Window} from 'happy-dom';import {IDBFactory} from 'fake-indexeddb';
import {fixture} from './reliability-fixture.ts';
test('prepared workspace download remains accessible and export failure is visible inside its dialog',async t=>{
 const win=new Window({url:'https://example.test/uvyazka/'}),names=['document','localStorage','addEventListener','indexedDB'],old=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
 globalThis.document=win.document;globalThis.localStorage=win.localStorage;globalThis.addEventListener=win.addEventListener.bind(win);globalThis.indexedDB=new IDBFactory();
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;};
 document.body.innerHTML='<button id="open-workspace">Workspace</button>';document.addEventListener('click',event=>{if(event.target.closest?.('a'))event.preventDefault();});
 t.after(()=>{win.dispatchEvent(new win.Event('pagehide'));for(const [name,value]of Object.entries(old))globalThis[name]=value;delete globalThis.__archiveFailure;win.happyDOM.close();});
 const bundled=await build({entryPoints:['src/workspace-panel.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'service-stubs',setup(build){
  build.onResolve({filter:/^\.\/(workspace-archive-client|review-client|viewer-workspace)$/},args=>({path:args.path,namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='./workspace-archive-client'?"export async function archiveTask(){if(globalThis.__archiveFailure)throw Error('Synthetic archive failure');return new Uint8Array([1,2,3]);}":args.path==='./review-client'?"export class ReviewRepository {async snapshot(){return []}}":"export async function sceneStore(){return []}export async function sharedWorkspace(){return {}}"}));
 }}]});
 const {workspacePanel}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
 const scene=fixture(),errors=[];workspacePanel({project:()=>scene.project_id,capture:()=>scene,restore:async()=>{},apply:()=>{},matches:()=>[],selection:()=>[],show:()=>{},highlight:()=>{},error:e=>errors.push(e),shared:false});
 const wait=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Workspace state not reached');};
 document.querySelector('#open-workspace').click();await wait(()=>document.querySelector('dialog')?.open);
 const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Скачать проект .uvz');button.click();await wait(()=>document.querySelector('.workspace-project-download')?.hidden===false);
 const link=document.querySelector('.workspace-project-download');assert.equal(link.download,'uvyazka-project.uvz');assert.match(link.href,/^blob:/);assert.equal((await fetch(link.href)).status,200);
 globalThis.__archiveFailure=true;button.click();await wait(()=>document.querySelector('dialog [role=status]').textContent==='Не удалось выполнить действие. Подробности доступны в диагностике.');
 assert.equal(link.hidden,true);assert.equal(button.disabled,false);assert.equal(errors.length,1);
 const diagnostics=document.querySelector('.workspace-error-diagnostics');assert.equal(diagnostics.open,false);diagnostics.open=true;diagnostics.dispatchEvent(new win.Event('toggle'));assert.equal(diagnostics.querySelector('pre').textContent,'Synthetic archive failure');
});
