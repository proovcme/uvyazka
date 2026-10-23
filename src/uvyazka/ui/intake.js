/* Shared local intake. Transfer progress measures bytes; parsing reports actual stages. */
window.UvyazkaIntake = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {receiving:'Передача файлов',queued:'Ожидает обработки',extracting:'Распаковка ZIP',indexing:'Чтение документов',ready:'Извлечение завершено',partial:'Извлечено частично',failed:'Обработка остановлена'};
  const methods = {linked_folder:'Подключённая папка',folder_upload:'Копия папки',zip_upload:'ZIP-архив'};
  const coverageNames = {text_indexed:'Текст прочитан',unsupported:'Нужен отдельный обработчик',parse_failed:'Не удалось прочитать',empty_text:'Текст не найден',pending:'Ожидают чтения',source_missing:'Источник недоступен'};
  const size = n => new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format((n||0)/1024/1024)+' МБ';

  async function mount(target, {openProject, projectsChanged}) {
    // Intent: RP/GIP brings a document package, sees the handoff and opens its shared memory.
    // Hierarchy: one intake form, followed by real jobs. Paper/ink/teal reuse the existing workbench.
    // Depth: existing panel borders; spacing 8/16/24; typography inherited, headings 22/600.
    target.innerHTML=`<div class="intake-root"><section class="panel"><div class="panel-head"><h2>Один проект для вас и модели</h2></div><form class="intake-form">
      <p class="intake-lead">Добавьте комплект документов. Увязка сохранит состав, извлечёт доступные данные и покажет, что требует дальнейшего разбора.</p>
      <label>Название проекта<input name="name" maxlength="200" placeholder="Например, Инновационный центр" required></label>
      <fieldset><legend>Откуда взять документы</legend><div class="intake-methods">
      <label><input type="radio" name="mode" value="linked_folder" checked><strong>Папка на компьютере</strong><span>Подключить по пути, без копирования</span></label>
      <label><input type="radio" name="mode" value="folder_upload"><strong>Выбрать папку</strong><span>Загрузить копию с вложенными папками</span></label>
      <label><input type="radio" name="mode" value="zip_upload"><strong>Архив ZIP</strong><span>Загрузить и распаковать структуру</span></label></div></fieldset>
      <label class="intake-path">Полный путь на этом компьютере<input name="source_root" placeholder="C:\\Проекты\\Мой проект" spellcheck="false"><small>Исходные файлы читаются по этому пути. Изменения обнаружатся при повторном чтении.</small></label>
      <label class="intake-folder" hidden>Выберите папку проекта<input name="folder" type="file" webkitdirectory multiple><small>Браузер передаст копию файлов в хранилище Увязки.</small></label>
      <label class="intake-zip" hidden>Выберите ZIP<input name="archive" type="file" accept=".zip,application/zip,application/x-zip-compressed"></label>
      <div class="intake-actions"><button class="rvt-primary" type="submit" disabled>Добавить и прочитать файлы</button><button type="button" class="source-button" data-new hidden>Начать новый приём</button></div>
      <p class="intake-message" role="status">Подключаем локальное хранилище…</p><progress hidden aria-label="Передача файлов"></progress>
      <p class="intake-handoff">После приёма вы открываете проект здесь, а модель — через MCP. Показатели, источники и результаты работы хранятся вместе.</p>
      <details><summary>Где хранятся данные</summary><p class="intake-storage"></p><p>Для продолжения из ИИ-клиента подключите MCP Увязки к этому же хранилищу.</p></details>
    </form></section><section class="panel"><div class="panel-head"><h2>Приём и продолжение работы</h2><button class="source-button" type="button" data-refresh>Обновить</button></div><div class="intake-jobs" aria-live="polite"></div></section></div>`;
    const root=target.firstElementChild, form=root.querySelector('form'), message=root.querySelector('.intake-message'), progress=root.querySelector('progress');
    const submit=form.querySelector('[type=submit]'), jobsTarget=root.querySelector('.intake-jobs');
    let token='', uploadId='', busy=false, items=[], seenProjects=new Set();
    const mode=()=>form.elements.mode.value;
    function showMode(){for(const [key,selector] of [['linked_folder','.intake-path'],['folder_upload','.intake-folder'],['zip_upload','.intake-zip']])root.querySelector(selector).hidden=key!==mode();}
    form.elements.mode.forEach(r=>r.addEventListener('change',()=>{uploadId='';showMode();}));
    form.elements.folder.onchange=()=>{if(!form.elements.name.value&&form.elements.folder.files.length)form.elements.name.value=form.elements.folder.files[0].webkitRelativePath.split('/')[0];};
    form.elements.archive.onchange=()=>{if(!form.elements.name.value&&form.elements.archive.files.length)form.elements.name.value=form.elements.archive.files[0].name.replace(/\.zip$/i,'');};
    async function request(action, body){
      const response=await fetch('/api/intake/'+action,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Uvyazka-Token':token},body:body===undefined?undefined:JSON.stringify(body)});
      const data=await response.json();if(!response.ok)throw Error(data.error);return data;
    }
    function report(error){message.textContent=error.message;message.setAttribute('role','alert');}
    function upload(action,file,query,onprogress){return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('POST','/api/intake/'+action+'?'+new URLSearchParams(query));xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-Uvyazka-Token',token);
      xhr.upload.onprogress=e=>{if(e.lengthComputable)onprogress(e.loaded);};
      xhr.onload=()=>{try{const d=JSON.parse(xhr.responseText);xhr.status<300?resolve(d):reject(Error(d.error));}catch(e){reject(e);}};
      xhr.onerror=()=>reject(Error('Связь прервалась. После восстановления выберите приём и повторите передачу.'));
      xhr.send(file);
    });}
    function renderJobs(){
      const focused=document.activeElement?.closest('.intake-jobs button');
      const focusKey=focused?['open','resume','retry','transfer'].find(k=>focused.dataset[k]):null;
      const focusValue=focusKey?focused.dataset[focusKey]:null;
      jobsTarget.innerHTML=items.length?items.map(item=>{
        const awaiting=['queued','extracting','indexing'].includes(item.status)&&!item.running;
        const coverage=Object.entries(item.coverage||{}).map(([k,n])=>`${coverageNames[k]||k}: ${n}`).join(' · ');
        return `<article class="intake-job"><div class="intake-job-heading"><div><h3>${esc(item.name)}</h3><span class="fact-id">${esc(methods[item.mode])} · ${esc(item.project_id||'Проект появится после передачи файлов')}</span></div><span class="badge">${esc(awaiting?'Можно продолжить':item.status==='indexing'&&item.phase==='inventory'?'Сверка состава и версий':labels[item.status])}</span></div>
          ${item.current_document?`<p class="file-name">${esc(item.current_document)}</p>`:''}
          ${item.running?'<progress aria-label="Обработка файлов"></progress>':''}
          <p>${item.status==='receiving'?`Передано файлов: ${item.received_files} / ${item.total_files||'архив'}. ${size(item.received_bytes)}`:item.status==='extracting'?`Распаковано: ${item.expanded_files||0} / ${item.total_files||'…'}`:esc(coverage||'Готовим состав документов…')}</p>
          ${item.reading_work?.counts?.low_text_blocks?`<p>Мало текста или сканы: ${item.reading_work.counts.low_text_blocks} страниц / блоков. Нужен просмотр и, по задаче, OCR.</p>`:''}
          ${item.error?`<p class="error">${esc(item.error)}</p>`:''}
          ${item.errors?.length?`<details><summary>Документы, которые не удалось прочитать (${item.coverage?.parse_failed||item.errors.length})</summary><ul>${item.errors.map(e=>`<li><strong>${esc(e.relative_path||e.doc_id)}</strong><p>${esc(e.error)}</p></li>`).join('')}</ul><p>Показаны первые 20; полный состав доступен в документах проекта.</p></details>`:''}
          <div class="intake-actions">${item.project_id?`<button type="button" class="rvt-primary" data-open="${esc(item.project_id)}">Открыть проект →</button>`:''}
          ${item.can_resume?`<button type="button" class="source-button" data-resume="${esc(item.intake_id)}">${item.status==='ready'||item.status==='partial'?'Обновить чтение':'Продолжить обработку'}</button>`:''}
          ${item.coverage?.parse_failed&&!item.running?`<button type="button" class="source-button" data-retry="${esc(item.intake_id)}">Повторить неудавшееся чтение</button>`:''}
          ${item.status==='receiving'?`<button type="button" class="source-button" data-transfer="${esc(item.intake_id)}">Продолжить передачу</button>`:''}</div>
          <details><summary>Журнал · обновлено ${esc(new Date(item.updated_at).toLocaleString('ru-RU'))}</summary><ol>${item.journal.map(e=>`<li><time>${esc(new Date(e.created_at).toLocaleTimeString('ru-RU'))}</time> ${esc(labels[e.status]||e.status)}<small>${esc(e.detail)}</small></li>`).join('')}</ol><small>Приём: ${esc(item.intake_id)}</small></details>
          ${['ready','partial'].includes(item.status)?'<p class="intake-note">Извлечение файлов завершено. Смысл показателей и согласованность разделов требуют дальнейшего разбора.</p>':''}</article>`;
      }).join(''):'<div class="empty">Здесь появятся проекты, добавленные вами или моделью через MCP.</div>';
      if(focusKey)Array.from(jobsTarget.querySelectorAll('button')).find(b=>b.dataset[focusKey]===focusValue)?.focus({preventScroll:true});
    }
    async function refresh(){
      const data=await request('jobs');if(!root.isConnected)return;
      items=data.items;renderJobs();
      const newProjects=items.filter(i=>i.project_id&&!seenProjects.has(i.project_id));
      if(newProjects.length){newProjects.forEach(i=>seenProjects.add(i.project_id));await projectsChanged();}
    }
    form.onsubmit=async event=>{
      event.preventDefault();if(busy)return;busy=true;submit.disabled=true;form.querySelectorAll('input').forEach(e=>e.disabled=true);message.setAttribute('role','status');
      try{
        const name=form.elements.name.value.trim();let job;
        if(mode()==='linked_folder'){
          message.textContent='Подключаем папку…';job=await request('folder',{source_root:form.elements.source_root.value.trim(),name});
        }else{
          const files=mode()==='folder_upload'?Array.from(form.elements.folder.files):Array.from(form.elements.archive.files);
          if(!files.length)throw Error('Сначала выберите папку или ZIP.');
          job=uploadId?{intake_id:uploadId}:await request('start',{mode:mode(),name,files:mode()==='folder_upload'?files.map(f=>({path:f.webkitRelativePath,size:f.size})):undefined});
          uploadId=job.intake_id;root.querySelector('[data-new]').hidden=false;
          progress.hidden=false;progress.max=Math.max(1,files.reduce((n,f)=>n+f.size,0));progress.value=0;let sent=0;
          for(let n=0;n<files.length;n++){
            const file=files[n];message.textContent=`Передаём ${n+1} / ${files.length}: ${file.name}`;
            await upload(mode()==='folder_upload'?'file':'archive',file,{intake_id:uploadId,...(mode()==='folder_upload'?{path:file.webkitRelativePath}:{})},bytes=>{progress.value=sent+bytes;});sent+=file.size;
          }
          if(mode()==='folder_upload')job=await request('finish',{intake_id:uploadId});
          uploadId='';progress.hidden=true;
        }
        message.textContent='Приём сохранён. Ход чтения и кнопка открытия проекта — ниже.';await refresh();
      }catch(e){report(e);await refresh().catch(()=>{});}finally{busy=false;submit.disabled=false;form.querySelectorAll('input').forEach(e=>e.disabled=false);}
    };
    root.addEventListener('click',async event=>{
      const b=event.target.closest('button');if(!b||busy)return;
      try{
        if(b.dataset.open){await openProject(b.dataset.open);return;}
        if(b.hasAttribute('data-new')){uploadId='';message.textContent='Можно выбрать новый комплект.';b.hidden=true;}
        if(b.dataset.transfer){const job=items.find(i=>i.intake_id===b.dataset.transfer);uploadId=job.intake_id;form.elements.mode.value=job.mode;form.elements.name.value=job.name;showMode();message.textContent='Выберите ту же папку или ZIP и нажмите «Добавить и прочитать файлы».';root.querySelector('[data-new]').hidden=false;form.scrollIntoView({block:'start'});}
        if(b.dataset.resume||b.dataset.retry){b.disabled=true;await request('resume',{intake_id:b.dataset.resume||b.dataset.retry,retry_failed:!!b.dataset.retry});}
        if(b.hasAttribute('data-refresh')||b.dataset.resume||b.dataset.retry)await refresh();
      }catch(e){report(e);b.disabled=false;}
    });
    try{const runtime=await request('runtime');token=runtime.write_token;root.querySelector('.intake-storage').textContent=runtime.storage;message.textContent='Готово к приёму. Обработка выполняется на этом компьютере.';submit.disabled=false;await refresh();}catch(e){report(e);}
    async function poll(){if(!root.isConnected)return;try{await refresh();}catch(e){report(e);}if(root.isConnected)setTimeout(poll,2500);}
    setTimeout(poll,2500);
  }
  return {mount};
})();
