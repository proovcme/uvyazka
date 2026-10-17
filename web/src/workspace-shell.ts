// Compact CAD workspace. Native controls retain keyboard and focus behaviour.
const paths:Record<string,string>={
 cube:'<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"/>',
 layers:'<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
 open:'<path d="M3 7V5h6l2 2h10v13H3zM3 11h18"/>',
 sliders:'<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 fit:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
 cut:'<path d="M4 4h16v16H4zM2 15 22 9"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
 list:'<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
 top:'<path d="M4 4h16v16H4zM4 10h16M10 4v16"/>',
 play:'<path d="m9 5 11 7-11 7z"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>'
};
export const icon=(name:string)=>`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name]||paths.cube}</svg>`;
export const workspaceShell=`
<header class="app-header">
  <a class="brand" id="memory-link" href="/" aria-label="Увязка — база проекта">${icon('layers')}<span>увязка</span></a>
  <label class="project-picker"><select id="projects" aria-label="Проект"></select></label>
  <nav class="mode-switch" aria-label="Режим работы"><button id="mode-view" aria-pressed="true">Просмотр</button><button id="mode-simulate" aria-pressed="false">Симуляция</button></nav>
  <div class="header-actions"><button id="help" class="icon-button" aria-label="Справка" title="Справка">${icon('info')}</button><a id="back" href="/">База проекта</a><button id="open-file" class="primary" aria-label="Открыть файл" title="Открыть файл">${icon('open')}<span>Открыть файл</span></button></div>
</header>
<main>
  <div class="workspace-bar">
    <button id="toggle-tree" aria-label="Структура модели" aria-expanded="true" aria-controls="model-panel">${icon('layers')}<span>Структура</span></button>
    <div class="file-heading"><h1 id="file-title">Загрузка модели…</h1><span id="geometry-kind"></span></div>
    <button id="file-settings" aria-label="Модель и параметры расчёта" title="Модель и параметры расчёта">${icon('sliders')}<span>Параметры</span></button>
    <button id="toggle-inspector" aria-label="Свойства модели" aria-expanded="false" aria-controls="properties-panel">${icon('list')}<span>Свойства</span></button>
  </div>
  <div class="error" id="error" role="alert" hidden></div>
  <div class="workspace">
    <aside class="model-tree" id="model-panel">
      <div class="panel-head"><h2>Структура модели</h2><button id="close-tree" class="icon-button" aria-label="Скрыть структуру">${icon('close')}</button></div>
      <div class="tree-tools"><label class="search-field">${icon('search')}<input id="element-search" aria-label="Поиск элемента" type="search" placeholder="Найти элемент"></label><label>Этаж<select id="storey-filter"><option value="">Все этажи</option></select></label></div>
      <div id="element-tree"></div><button id="reset-visibility" class="reset-tree">Показать всю модель</button>
    </aside>
    <section class="scene" aria-label="Рабочая область модели">
      <div id="canvas"></div><div id="cad-host" hidden></div><div id="no-model">Откройте файл, чтобы увидеть модель</div>
      <div class="scene-tools" aria-label="Вид модели"><button id="iso" title="Общий вид">${icon('cube')}<span>3D</span></button><button id="top" title="Вид сверху">${icon('top')}<span>Сверху</span></button><button id="cut" aria-pressed="false">${icon('cut')}<span>Разрез</span></button><button id="fit" title="Вписать модель · F">${icon('fit')}<span>Вписать</span></button></div>
      <div class="canvas-hint">Вращение — мышь <span>Перемещение — правая кнопка</span> Масштаб — колесо</div>
    </section>
    <aside class="properties-panel" id="properties-panel"><div class="panel-head"><h2 id="inspector-title">Свойства модели</h2><button id="close-inspector" class="icon-button" aria-label="Скрыть свойства">${icon('close')}</button></div><div class="properties-scroll"><div class="inspector" id="inspector"></div><div class="inspector" id="resources"></div></div></aside>
  </div>
  <section class="simulation-dock simulation-only" aria-label="Управление симуляцией">
    <div class="simulation-toolbar"><label class="run-picker">Сценарий<select id="runs" aria-label="Рассчитанный сценарий"></select></label><label class="scene-picker">Этап<select id="scenes" aria-label="Сцена работ"><option value="">Выберите сцену</option></select></label><button id="tour" aria-pressed="false">Автопоказ</button><button id="worker-route">Путь бригады</button><label class="check"><input id="site" type="checkbox" checked>Площадка</label><label class="check"><input id="show-complete" type="checkbox" checked>Вся модель</label></div>
    <div class="playback"><button id="play" aria-label="Воспроизвести" class="primary" disabled>▶</button><button id="rewind" aria-label="В начало" disabled>↶</button><span id="clock">0 мин</span><input id="time" type="range" min="0" max="1" value="0" aria-label="Виртуальное время" disabled><select id="rate" aria-label="Скорость"><option value="1">1×</option><option value="10">10×</option><option value="60" selected>60×</option><option value="240">240×</option></select><button id="toggle-schedule" aria-expanded="false" aria-controls="schedule-panel">${icon('list')}График</button></div>
    <section class="schedule-panel" id="schedule-panel"><div class="metrics" id="metrics"></div><div class="schedule-wrap"><table><thead><tr><th>Работа</th><th>Начало / конец, мин</th><th>Ход работ</th><th>Основание</th></tr></thead><tbody id="schedule"></tbody></table></div><div class="export-actions"><a id="csv" hidden>График CSV</a><a id="journal" hidden>Журнал JSON</a><small>● Критическая работа по связям, без ограничений ресурсов</small></div></section>
  </section>
</main>
<footer class="status-bar"><span class="status-indicator" aria-hidden="true"></span><span id="workspace-status" role="status">Учебная модель</span><button id="status-details">Подробности</button><span class="privacy-label">Локальная обработка</span><span class="formats">DWG / RVT / IFC</span></footer>
<dialog id="file-dialog" aria-labelledby="file-dialog-title"><div class="panel-head"><h2 id="file-dialog-title">Файл и параметры</h2><button id="close-file" class="icon-button" aria-label="Закрыть параметры">${icon('close')}</button></div><div class="dialog-content"><label>Сохранённая модель<select id="models" aria-label="Пространственная модель"></select></label><div id="import-host"></div><details class="notes simulation-only"><summary>Допущения и покрытие</summary><div id="assumptions">Нет выбранного расчёта.</div></details></div></dialog>
<dialog id="help-dialog" aria-labelledby="help-title"><div class="panel-head"><h2 id="help-title">Работа с моделью</h2><button id="close-help" class="icon-button" aria-label="Закрыть справку">${icon('close')}</button></div><div class="dialog-content"><p>Откройте DWG, DXF, RVT или IFC. Выберите элемент на модели или в структуре — его свойства появятся справа.</p><dl><dt>Вращение</dt><dd>Левая кнопка мыши</dd><dt>Перемещение</dt><dd>Правая кнопка или стрелки</dd><dt>Масштаб</dt><dd>Колесо мыши</dd><dt>Вписать модель</dt><dd>F при фокусе на холсте</dd><dt>Снять выделение</dt><dd>Escape при фокусе на холсте</dd></dl><div class="notice">Расчётный сценарий содержит допущения и не заменяет ПОС/ППР.</div><p>RVT читается частично. DWG/DXF доступны для просмотра чертежей; симуляция рассчитывается по IFC/RVT.</p></div></dialog>`;
