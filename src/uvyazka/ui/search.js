/* RP/GIP locate evidence before inspecting a sheet. Signature: source → address → SHA.
   Query leads; coverage and preparation stay secondary. Existing paper/ink/accent,
   borders only, inherited Segoe; monospace addresses, 8/16/24px spacing. */
window.UvyazkaSearch = (() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const modes={literal:'Точный',semantic:'По смыслу',hybrid:'Совмещённый'};
  const reasons={worker_not_configured:'Локальный embedding-worker не настроен.',index_not_prepared:'Индекс по смыслу ещё не подготовлен.',index_model_changed:'Модель изменилась — подготовьте индекс заново.',identifier_lookup_uses_exact_terms:'Марку или ID с цифрами ищем точно.',query_exceeds_runtime_budget:'Запрос длиннее лимита локального worker. Сократите формулировку.'};
  function address(r){const l=r.locator||{};if(l.kind==='pdf_region')return `PDF ${l.pdf_page} · вид ${l.view_id} · область ${l.region.join(', ')}`;if(l.kind==='pdf_page')return `PDF ${l.pdf_page}`;if(l.sheet)return `${l.sheet} · строка ${l.row}`;if(l.table)return `Таблица ${l.table} · строка ${l.row}`;return `Блок ${r.page_number}${l.paragraph?' · абзац '+l.paragraph:''}`;}
  async function mount(host,project){
    host.innerHTML=`<section class="project-search"><div class="panel"><form data-search-form class="memory-search-form"><label>Найти в проекте<input data-query maxlength="500" required placeholder="Например: питание насосов повышения давления" autocomplete="off"></label><label>Режим<select data-mode><option value="hybrid">Совмещённый</option><option value="literal">Точный</option><option value="semantic">По смыслу</option></select></label><button class="rvt-primary" type="submit">Найти</button></form><p class="detail-info">Марки и ID с цифрами ищутся точно. Поиск по смыслу помогает найти формулировки смежников; результаты ещё требуют чтения источника.</p></div><details class="panel memory-index"><summary>Подготовка поиска по смыслу <span data-status>Читаем состояние…</span></summary><p data-coverage></p><p>Индекс содержит подготовленные текстовые блоки и явно сохранённые области PDF. Непрочитанные файлы и остальные области сканов в него не входят.</p><button data-build disabled>Подготовить индекс</button> <button data-stop hidden>Остановить после порции</button><p data-progress role="status"></p><p data-setup hidden>Для включения настройте локальный worker командой <code>uvyazka configure-embeddings</code>. Точный поиск уже доступен.</p></details><p data-error role="alert"></p><p data-result-status role="status"></p><div data-results></div></section>`;
    const root=host.firstElementChild,$=s=>root.querySelector(s),alive=()=>root.isConnected;
    let stop=false,busy=false,searchGeneration=0;
    const url=(path,params={})=>'/api/semantic/'+path+'?'+new URLSearchParams({project_id:project,...params});
    async function request(path,params={}){const r=await fetch(url(path,params)),d=await r.json();if(!r.ok)throw Error(d.error);return d;}
    function error(e){if(alive())UvyazkaLanguage.showError($('[data-error]'),e);}
    function status(s){
      $('[data-status]').textContent=`· готово ${s.counts.ready}, ожидают ${s.counts.pending}, не удалось ${s.counts.failed}`;
      $('[data-coverage]').textContent=`Состав индекса: ${s.prepared_documents??0} источников. В базе доступен кеш ${s.cached_documents??0} файлов (${s.cached_blocks} блоков). Счётчики «ожидают» и «готово» относятся к составу индекса, а не ко всему проекту. Хеш исходника проверяется при выдаче результата.`;
      $('[data-build]').disabled=busy||!s.configured;$('[data-setup]').hidden=s.configured;
      if(s.configuration_error)UvyazkaLanguage.showError($('[data-setup]'),s.configuration_error,'Поиск по смыслу пока не настроен. Точный поиск доступен.');
    }
    $('[data-search-form]').onsubmit=async e=>{
      e.preventDefault();const query=$('[data-query]').value.trim();if(!query)return;
      const generation=++searchGeneration,button=e.currentTarget.querySelector('button');button.disabled=true;
      $('[data-error]').textContent='';$('[data-result-status]').textContent='Ищем в подготовленных данных…';$('[data-results]').innerHTML='';
      try{
        const r=await request('search',{q:query,mode:$('[data-mode]').value});if(!alive()||generation!==searchGeneration)return;
        status(r.status);$('[data-result-status]').textContent=`${modes[r.effective_mode]} поиск · ${r.results.length} фрагментов. ${r.fallback_reason?(reasons[r.fallback_reason]||'Поиск выполнен в доступном режиме.'):''}`;
        $('[data-results]').innerHTML=r.results.map(x=>`<article class="panel memory-hit"><h2>${esc(x.relative_path)}</h2><div class="memory-address">${esc(address(x))}</div><p class="memory-snippet">${esc(x.snippet)}</p><div class="memory-hit-foot"><button class="source-button" data-source="${esc(JSON.stringify({doc_id:x.doc_id,sha256:x.sha256,parser_revision:x.parser_revision,page_number:x.page_number}))}">Открыть источник ↗</button><span>${x.retrieval_kind==='literal'?'Точное совпадение':'По смыслу'}</span><details><summary>Версия и диагностика</summary><code>SHA-256 ${esc(x.sha256)}</code><p>Читатель: ${esc(x.parser_revision)}${x.similarity==null?'':' · cosine '+esc(x.similarity)+' (не вероятность достоверности)'}</p></details></div></article>`).join('')||'<div class="panel detail-info">В текущем покрытии подходящих фрагментов нет. Это не доказывает отсутствия данных в проекте.</div>';
      }catch(e){error(e);if(alive())$('[data-result-status]').textContent='Поиск не завершён.';}
      finally{if(alive()&&generation===searchGeneration)button.disabled=false;}
    };
    $('[data-stop]').onclick=()=>{stop=true;$('[data-stop]').disabled=true;};
    $('[data-build]').onclick=async()=>{
      busy=true;stop=false;$('[data-build]').disabled=true;$('[data-stop]').hidden=false;$('[data-stop]').disabled=false;$('[data-error]').textContent='';
      const start=Date.now();let count=0,failed=false;
      const progress=()=>{if(alive())$('[data-progress]').textContent=`Обработано в этом запуске: ${count} · ${Math.floor((Date.now()-start)/1000)} с. ${stop?'Останавливаемся после текущей порции.':'Готовим следующую порцию; первая подготовка поиска может занять несколько минут.'}`;};
      progress();const timer=setInterval(progress,1000);
      try{
        const cr=await fetch('/api/structure/config'),config=await cr.json();if(!cr.ok)throw Error(config.error);if(!alive())return;
        do{
          if(stop||!alive())break;
          const response=await fetch(url('build'),{method:'POST',headers:{'Content-Type':'application/json','X-Uvyazka-Token':config.write_token},body:JSON.stringify({limit:12})}),r=await response.json();
          if(!response.ok)throw Error(r.error);if(!alive())break;
          count+=r.processed.length;status(r.status);progress();
          if(!r.status.counts.pending||!r.processed.length)break;
        }while(!stop);
      }catch(e){failed=true;error(e);}
      finally{clearInterval(timer);busy=false;if(alive()){$('[data-stop]').hidden=true;$('[data-progress]').textContent=`${failed?'Запуск прерван ошибкой.':stop?'Приостановлено.':'Запуск завершён.'} Обработано ${count} · ${Math.floor((Date.now()-start)/1000)} с. Готовые фрагменты сохранены.`;try{status(await request('status'));}catch(e){error(e);}}}
    };
    try{const s=await request('status');if(alive())status(s);}catch(e){error(e);}
  }
  return {mount};
})();
