/* Local file intake uses the same deterministic service as MCP. No agent. */
window.UvyazkaRvt = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={queued:'В очереди',extracting:'Чтение данных, видов и спецификаций',converting:'Преобразование геометрии в IFC и проверка',linking:'Сопоставление данных и геометрии',planning:'Расчёт условного сценария',completed:'Обработка завершена',failed:'Не удалось завершить обработку',previous_session:'Задание из другого сеанса панели'};
  const nativeStatus={complete_bounded_graph:'Сохранённые поля прочитаны',partial_metadata:'Неполные параметры',record_exceeds_2MiB:'Запись превышает предел чтения'};
  const stageNames={extracted_requires_review:'Данные прочитаны · нужна проверка',partial:'Частично · есть вопросы',converted_requires_review:'IFC получен · нужна проверка',failed:'Этап не выполнен',not_requested:'Не запрошено'};
  async function mount(project,target){
    target.innerHTML='<div class="rvt-root"></div>';const root=target.firstElementChild;
    const path=(name,query={})=>'/api/rvt/'+name+'?'+new URLSearchParams({project_id:project,...query});
    const api=async(name,query={})=>{const r=await fetch(path(name,query));const d=await r.json();if(!r.ok)throw Error(d.error);return d;};
    const panel=(title,body)=>`<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div>${body}</section>`;
    root.innerHTML=panel('RVT → данные и модель',`<div class="rvt-form"><p class="rvt-intro">Загрузите модель в текущий проект. Приложение извлекает доступные параметры, виды и спецификации и подготавливает модель для 3D. Полнота будет видна в отчёте.</p><p class="rvt-location">Без агента и без Revit. Обработка — на этом компьютере.</p><form id="rvt-upload-form"><label class="rvt-file-label" for="rvt-file">Файл модели RVT <small>до 512 MiB</small></label><input id="rvt-file" type="file" accept=".rvt" required><label class="rvt-check"><input id="rvt-simulate" type="checkbox" checked> Добавить условный сценарий работ для симуляции</label><p class="rvt-help">Сценарий строится по всей модели без разделения стадий. Выработка, состав работ и ресурсы требуют проверки.</p><button class="rvt-primary" type="submit" disabled>Загрузить и обработать</button><p class="rvt-message" role="status" aria-live="polite">Проверяем готовность обработчика…</p><progress class="rvt-progress" hidden max="100" value="0" aria-label="Передача файла"></progress></form></div>`)+`<div class="rvt-job"></div><div class="rvt-data"></div>`;
    const form=root.querySelector('form'),file=root.querySelector('#rvt-file'),button=form.querySelector('button'),message=form.querySelector('.rvt-message'),progress=form.querySelector('progress');
    const jobTarget=root.querySelector('.rvt-job'),dataTarget=root.querySelector('.rvt-data');
    let runtime,activeJob='',extraction='',section='views',offset=0,query='',dataSerial=0,recordSerial=0,recordState=null,nextPage=null,pageHistory=[];
    function error(e){if(root.isConnected){UvyazkaLanguage.showError(message,e);}}
    function renderJob(job){
      if(!root.isConnected)return;
      const result=job.result,data=result?.stages.data,geometry=result?.stages.geometry;
      const busy=['queued','extracting','converting','linking','planning'].includes(job.status);
      jobTarget.innerHTML=panel(labels[job.status]||job.status,`<div class="rvt-job-body" role="status"><strong>${esc(job.filename)}</strong>${busy?'<progress aria-label="Обработка модели"></progress><p>Файл обрабатывается. Можно перейти в другой раздел и вернуться к результату.</p>':''}${job.status==='previous_session'?'<p>Автоматическое возобновление после перезапуска не выполняется. Проверьте другую открытую панель или загрузите файл повторно.</p>':''}${job.error?`<div class="error">${UvyazkaLanguage.errorHtml(job.error)}</div>`:''}${result?`<div class="rvt-stages"><div><h3>Данные</h3><p>${esc(stageNames[data.status]||"Данные требуют проверки")}</p><strong>${data.record_count??'—'} записей</strong><p>Видов: ${data.counts?.view??'—'} · спецификаций: ${data.counts?.schedule??'—'} · размещений: ${data.counts?.placement??'—'}</p>${data.error?`<div class="error">${UvyazkaLanguage.errorHtml(data.error)}</div>`:''}</div><div><h3>Геометрия</h3><p>${esc(stageNames[geometry.status]||"Геометрия требует проверки")}</p><strong>${geometry.element_count??'—'} элементов</strong>${geometry.error?`<div class="error">${UvyazkaLanguage.errorHtml(geometry.error)}</div>`:''}</div></div>${result.crosswalk?`<p>По точному ElementId сопоставлено ${result.crosswalk.matched_geometry_rows} из ${result.crosswalk.geometry_rows} элементов геометрии.</p>`:''}${geometry.model_id?`<a class="rvt-primary" href="/simulation/?${new URLSearchParams({project,model:geometry.model_id,...(job.simulation?.run?.run_id?{run:job.simulation.run.run_id}:{})})}">Открыть 3D${job.simulation?.run?' и симуляцию':''} →</a>`:''}${job.simulation?`<p>${job.simulation.status==='failed'?'Сценарий не рассчитан: '+esc(job.simulation.error):'Рассчитан условный сценарий: '+job.simulation.operation_count+' работ. '+esc(job.simulation.interpretation)}</p>`:''}<details><summary>Отчёт этапов и происхождение</summary><pre class="source-text">${esc(JSON.stringify(result,null,2))}</pre></details><p class="rvt-help">Сохранённые ячейки не гарантируют полного вычисленного тела спецификации. Настройки видов не являются готовыми чертежами.</p>`:''}</div>`);
      if(data?.extraction_id && extraction!==data.extraction_id){extraction=data.extraction_id;renderBrowser();}
    }
    async function poll(id){
      if(!root.isConnected||activeJob!==id)return;
      try{const job=await api('job',{job_id:id});if(!root.isConnected||activeJob!==id)return;renderJob(job);
        if(['queued','extracting','converting','linking','planning'].includes(job.status))setTimeout(()=>poll(id),1500);
      }catch(e){error(e);}
    }
    async function loadData(){
      if(!extraction||!root.isConnected)return;const serial=++dataSerial;
      const result=await api('data',{extraction_id:extraction,section,offset,q:query,limit:30});if(serial!==dataSerial||!root.isConnected)return;
      nextPage=result.next_offset;const rows=result.items||[];dataTarget.querySelector('.rvt-records').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Имя / класс</th><th>ElementId</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.name||row.key||UvyazkaLanguage.displayClass(row.class_name))}<details><summary>Исходная запись</summary><code>${esc(row.class_name||'')}</code><pre>${esc(JSON.stringify(row,null,2))}</pre></details></td><td>${esc(row.element_id||'—')}</td><td>${esc(nativeStatus[row.status]||"Требует проверки")}</td><td>${row.record_id!==undefined?`<button class="source-button" data-rvt-record="${row.record_id}">Читать →</button>`:''}</td></tr>`).join('')}</tbody></table></div>${rows.length?'':'<div class="empty">В этой выборке записей нет. Проверьте покрытие извлечения.</div>'}<div class="table-meta">Всего: ${result.total}<div class="pagination"><button data-rvt-page="prev" ${offset?'':'disabled'}>Назад</button><button data-rvt-page="next" ${result.next_offset===null?'disabled':''}>Далее</button></div></div>`;
    }
    function renderBrowser(){
      dataTarget.innerHTML=panel('Сохранённые данные RVT',`<div class="toolbar"><label>Выборка <select class="rvt-section"><option value="views">Виды</option><option value="schedules">Спецификации</option><option value="placements">Размещения</option><option value="elements">Все записи</option><option value="units">Единицы</option><option value="parameter_definitions">Определения параметров</option><option value="coverage">Покрытие по классам</option><option value="diagnostics">Вопросы чтения</option></select></label><label class="rvt-search-label">Поиск <input class="rvt-search" type="search" placeholder="Имя, класс или ElementId"></label></div><div class="rvt-records" aria-live="polite"></div><div class="rvt-detail"></div>`);
      dataTarget.querySelector('select').addEventListener('change',e=>{section=e.target.value;offset=0;pageHistory=[];loadData().catch(error);});
      let timeout;dataTarget.querySelector('input').addEventListener('input',e=>{query=e.target.value;offset=0;pageHistory=[];clearTimeout(timeout);timeout=setTimeout(()=>loadData().catch(error),250);});
      loadData().catch(error);
    }
    async function loadRecord(recordId,part='view',start=0,jsonPath=null){
      const serial=++recordSerial;const result=await api('record',{extraction_id:extraction,record_id:recordId,section:part,offset:start,...(jsonPath?{json_path:JSON.stringify(jsonPath)}:{})});if(!root.isConnected||serial!==recordSerial)return;
      recordState={recordId,part,next:result.next_offset,jsonPath};
      dataTarget.querySelector('.rvt-detail').innerHTML=`<div class="rvt-record-detail"><h3>ElementId ${esc(result.identity.element_id)}</h3><p>Сохранённые данные. Вычисленные строки и итоги Revit могут быть недоступны.</p><details><summary>Исходные поля и диагностика</summary><label>Содержимое <select class="rvt-record-section">${[['view','Настройки вида'],['fields','Все поля'],['parameters','Параметры'],['schedule_definition','Настройки и фильтры таблицы'],['schedule_fields','Столбцы таблицы'],['schedule_cells','Сохранённые ячейки'],['graph','Объекты графа'],['value','JSON целиком']].map(([value,label])=>`<option value="${value}" ${value===part?'selected':''}>${label}</option>`).join('')}</select></label><pre class="source-text">${esc(JSON.stringify(result,null,2))}</pre><button class="source-button" data-rvt-record-next ${result.next_offset===null?'disabled':''}>Следующий фрагмент →</button>${(result.items||[]).filter(row=>row.truncated&&row.json_path).map(row=>`<button class="source-button" data-rvt-path="${esc(JSON.stringify(row.json_path))}">Полное значение поля →</button>`).join('')}</details></div>`;
      dataTarget.querySelector('.rvt-record-section').addEventListener('change',e=>loadRecord(recordId,e.target.value).catch(error));
    }
    dataTarget.addEventListener('click',e=>{
      const button=e.target.closest('button');if(!button)return;
      if(button.dataset.rvtRecord!==undefined)loadRecord(Number(button.dataset.rvtRecord),section==='schedules'?'schedule_fields':'view').catch(error);
      if(button.dataset.rvtPage){if(button.dataset.rvtPage==='next'&&nextPage!==null){pageHistory.push(offset);offset=nextPage;}else offset=pageHistory.pop()??0;loadData().catch(error);}
      if(button.hasAttribute('data-rvt-record-next')&&recordState)loadRecord(recordState.recordId,recordState.part,recordState.next,recordState.jsonPath).catch(error);
      if(button.dataset.rvtPath&&recordState)loadRecord(recordState.recordId,'value',0,JSON.parse(button.dataset.rvtPath)).catch(error);
    });
    file.addEventListener('change',()=>{const item=file.files[0];message.textContent=item?`${item.name} · ${(item.size/1048576).toFixed(1)} MiB`:'';if(item&&(!item.name.toLowerCase().endsWith('.rvt')||item.size>512*1048576)){message.textContent='Выберите RVT до 512 MiB';button.disabled=true;}else button.disabled=!runtime?.data_ready;});
    form.addEventListener('submit',async e=>{
      e.preventDefault();const selected=file.files[0];if(!selected)return;button.disabled=true;file.disabled=true;message.setAttribute('role','status');message.textContent='Передача файла…';progress.hidden=false;progress.value=0;
      try{
        const job=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',path('upload',{filename:selected.name,simulate:root.querySelector('#rvt-simulate').checked?'1':'0'}));xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-Uvyazka-Token',runtime.upload_token);xhr.upload.onprogress=e=>{if(root.isConnected&&e.lengthComputable)progress.value=e.loaded/e.total*100;};xhr.onerror=()=>reject(Error('Связь с локальной панелью прервана'));xhr.onload=()=>{try{const result=JSON.parse(xhr.responseText);xhr.status===202?resolve(result):reject(Error(result.error));}catch(e){reject(e);}};xhr.send(selected);});
        if(!root.isConnected)return;++dataSerial;++recordSerial;extraction='';section='views';offset=0;query='';pageHistory=[];dataTarget.replaceChildren();message.textContent='Файл принят. Обработка запущена.';activeJob=job.job_id;renderJob(job);poll(activeJob);
      }catch(e){error(e);}finally{if(root.isConnected){button.disabled=!runtime?.data_ready;file.disabled=false;progress.hidden=true;}}
    });
    try{runtime=await api('runtime');if(!root.isConnected)return;button.disabled=!runtime.data_ready;message.textContent=runtime.data_ready?(runtime.geometry_ready?'Готово к чтению данных и обработке геометрии.':'Чтение данных готово; модуль геометрии не подготовлен. Его этап вернёт отдельный вопрос.'):'Обработчик RVT не подготовлен. Выполните настройку по руководству установки.';
      const jobs=await api('jobs');if(root.isConnected&&jobs.items.length){activeJob=jobs.items[0].job_id;renderJob(jobs.items[0]);poll(activeJob);}
    }catch(e){error(e);}
  }
  return {mount};
})();
