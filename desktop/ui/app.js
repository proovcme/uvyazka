/* Native capabilities stay in this bundled shell, never in the project iframe. */
import {invoke} from '@tauri-apps/api/core';
import {check} from '@tauri-apps/plugin-updater';
import {relaunch} from '@tauri-apps/plugin-process';
const ui=id=>document.getElementById(id);let backend='',update,installing=false;
const core={invoke};
async function boot(){
 ui('status').textContent='Запускаем локальное ядро проекта…';ui('retry').hidden=true;
 try{const ready=await core.invoke('start_backend');backend=ready.url;ui('version').textContent=ready.version+' · локальная база';ui('project').src=backend;ui('project').hidden=false;ui('startup').hidden=true;ui('updates').disabled=false;ui('mcp').disabled=false;ui('licenses').disabled=false;}
 catch(e){ui('status').textContent=String(e);ui('retry').hidden=false;}
}
ui('retry').onclick=boot;ui('close-settings').onclick=()=>ui('settings').close();
ui('settings').addEventListener('cancel',event=>{if(installing)event.preventDefault();});
function settings(title){ui('settings-title').textContent=title;ui('settings-body').replaceChildren();ui('settings').showModal();return ui('settings-body');}
function add(parent,tag,value){const e=document.createElement(tag);e.textContent=value;parent.append(e);return e;}
ui('licenses').onclick=async()=>{const body=settings('Лицензии и соответствующие исходники');try{const data=await fetch(backend+'api/desktop/licenses').then(r=>r.json());add(body,'pre',data.notice);add(body,'h3','Архивы исходников зависимостей');for(const source of data.sources){add(body,'pre',source.name+'\nSHA-256 '+source.sha256+'\n'+source.url);}const copy=add(body,'button','Копировать адрес выпуска с исходниками');copy.onclick=()=>navigator.clipboard.writeText(data.release);if(data.bundled_source){const a=add(body,'a','Исходники установленной Увязки (ZIP)');a.href=backend+'api/desktop/source.zip';a.download='uvyazka-source.zip';}}catch(e){add(body,'p',String(e));}};
ui('mcp').onclick=async()=>{const body=settings('Подключение ИИ-клиента через MCP');try{const config=await fetch(backend+'api/desktop/config').then(r=>r.json());add(body,'p','Клиент и приложение используют одну папку состояния. Подключение не требует открытого окна Увязки.');for(const [name,text]of Object.entries(config.clients)){add(body,'h3',name);add(body,'pre',text);const copy=add(body,'button','Копировать '+name);copy.onclick=()=>navigator.clipboard.writeText(text);}}catch(e){add(body,'p',String(e));}};
ui('updates').onclick=async()=>{
 const body=settings('Обновления · предварительные версии');const message=add(body,'p','Проверяем подписанный выпуск на GitHub…');
 try{update=await check();if(!update){message.textContent='Установлена актуальная версия.';return;}message.textContent='Доступна версия '+update.version;add(body,'pre',update.body??'');const install=add(body,'button','Скачать и установить');install.className='primary';install.onclick=async()=>{
  install.disabled=true;installing=true;ui('close-settings').disabled=true;let paused=false;
  try{const gate=await fetch(backend+'api/desktop/update-ready').then(r=>r.json());if(!gate.ready)throw Error(gate.reason);message.textContent='Скачиваем и проверяем подпись…';const bar=add(body,'progress','');let received=0,total=0;
   await update.download(event=>{if(event.event==='Started'){total=event.data.contentLength??0;if(total>0){bar.max=total;bar.value=0;}else bar.removeAttribute('value');}else if(event.event==='Progress'){received+=event.data.chunkLength;if(total>0)bar.value=received;message.textContent='Получено '+Math.round(received/1024/1024)+' MiB';}});
   // Core creates SQLite snapshots after active bundled MCP clients have stopped.
   const backup=await fetch(backend+'api/desktop/backup',{method:'POST',headers:{'X-Uvyazka-Token':gate.token}}).then(async r=>{const x=await r.json();if(!r.ok)throw Error(x.error);return x;});
   paused=true;message.textContent='Резервная копия базы создана. Установка обновления…';await core.invoke('stop_backend');await update.install();await relaunch();
  }catch(e){message.textContent=String(e);install.disabled=false;if(paused)try{await core.invoke('stop_backend');await boot();}catch{} }
  finally{installing=false;ui('close-settings').disabled=false;}
 };}catch(e){message.textContent='Не удалось проверить обновления: '+String(e)+'. Проекты доступны без сети.';}
};
boot();
