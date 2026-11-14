window.UvyazkaNorms = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function mount(root, projectId) {
    root.innerHTML='<section class="panel"><div class="panel-head"><h2>Нормативная библиотека</h2></div><div class="loading" role="status">Подключаем общую базу SP MCP…</div></section>';
    try {
      const response=await fetch('/api/norms/status'), status=await response.json();
      if(!root.isConnected)return;
      if(!response.ok||!status.ready){
        root.innerHTML='<section class="panel"><div class="panel-head"><h2>Подключите нормативную базу</h2></div><div class="rvt-form"><p>Поиск норм работает через SP MCP, без ИИ и ключей моделей.</p><p>Запустите <code>sp-mcp web</code>, затем повторите подключение. MCP и веб-интерфейс используют одну нормативную базу.</p><p class="form-note">Адрес сервиса: '+escape(status.url||'http://127.0.0.1:8767')+'</p><button class="rvt-primary" data-retry>Повторить подключение</button></div></section>';
        root.querySelector('[data-retry]').onclick=()=>mount(root,projectId);return;
      }
      const url='/norms/?'+new URLSearchParams({embed:'1',...(projectId?{project_id:projectId}:{})});
      root.innerHTML='<iframe title="Поиск нормативных документов, редакций и актуальности" class="norms-frame" src="'+escape(url)+'" style="width:100%;height:calc(100vh - 210px);min-height:720px;border:1px solid var(--line);border-radius:8px;background:#f6f7f3"></iframe>';
    } catch(error) {
      if(root.isConnected)root.innerHTML='<div class="error">Не удалось подключить нормативную библиотеку. Обновите страницу или проверьте запуск SP MCP.</div>';
    }
  }
  return {mount};
})();
