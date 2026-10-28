import test from 'node:test';import assert from 'node:assert/strict';
import {Window} from 'happy-dom';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';

test('window maximize preserves inputs, manual size and close controls across rebuilt headers',async t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());
 for(const k of ['document','HTMLElement','MutationObserver'])Object.defineProperty(globalThis,k,{value:win[k],writable:true,configurable:true});
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/window-controls.ts',import.meta.url))],bundle:true,write:false,format:'esm'});
 const {installWindowControls}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
 const stop=installWindowControls();t.after(stop);
 const dialog=document.createElement('dialog');dialog.innerHTML='<div class="panel-head"><h2>Таблица</h2><button aria-label="Закрыть таблицу">✕</button></div><input value="Сохранить ввод">';
 dialog.style.width='700px';document.body.append(dialog);await win.happyDOM.whenAsyncComplete();
 const button=()=>dialog.querySelector('[data-window-maximize]');button().click();
 assert.equal(dialog.classList.contains('window-expanded'),true);assert.equal(button().getAttribute('aria-pressed'),'true');assert.equal(dialog.querySelector('input').value,'Сохранить ввод');
 button().click();assert.equal(dialog.style.width,'700px');assert.equal(dialog.classList.contains('window-expanded'),false);
 dialog.querySelector('.panel-head').innerHTML='<h2>Другая таблица</h2><button aria-label="Закрыть">✕</button>';await win.happyDOM.whenAsyncComplete();
 assert.equal(dialog.querySelectorAll('[data-window-maximize]').length,1);assert.ok(dialog.querySelector('button[aria-label="Закрыть"]'));
 const review=document.createElement('aside');review.className='review-panel';review.innerHTML='<header><h2>Проверки</h2><button>Закрыть</button></header>';document.body.append(review);await win.happyDOM.whenAsyncComplete();
 review.querySelector('[data-window-maximize]').click();assert.equal(review.classList.contains('window-expanded'),true);
});
