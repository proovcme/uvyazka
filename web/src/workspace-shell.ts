// Compact CAD workspace. Native controls retain keyboard and focus behaviour.
const paths:Record<string,string>={
 cube:'<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"/>',
 layers:'<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
 open:'<path d="M3 7V5h6l2 2h10v13H3zM3 11h18"/>',
 sliders:'<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 fit:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
 ruler:'<path d="m3 16 13-13 5 5L8 21zM7 12l2 2M10 9l2 2M13 6l2 2"/>',
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
 <a class="brand" id="memory-link" href="/" aria-label="Увязка — база проекта">увязка</a>
 <div class="file-heading"><h1 id="file-title">Загрузка модели…</h1><span id="geometry-kind"></span></div>
 <nav class="mode-switch" aria-label="Режим работы"><button id="mode-view" aria-pressed="true">Модель</button><button id="mode-simulate" aria-pressed="false">Симуляция</button><a id="measurement-link" href="/measurements/" hidden>Лист и измерения ↗</a></nav>
 <div class="header-actions"><button id="theme-toggle" title="Переключить тему">Тёмная тема</button><a id="back" href="/">База проекта</a><button id="replace-model" title="Открыть файл вместо текущей сцены">Заменить сцену</button><button id="open-file" class="add-model-primary" aria-label="Добавить модель" title="Добавить RVT или IFC к сцене">${icon('open')}<span>Добавить модель</span></button></div>
</header>
<main>
 <nav class="tool-rail" aria-label="Инструменты модели">
  <button id="toggle-tree" aria-label="Структура модели" aria-expanded="true" aria-controls="model-panel">${icon('layers')}<span>Модель</span></button>
  <button id="iso" title="Аксонометрия">${icon('cube')}<span>3D</span></button>
  <button id="top" title="Вид сверху">${icon('top')}<span>План</span></button>
  <button id="cut" aria-pressed="false" aria-label="Разрез модели">${icon('cut')}<span>Разрез</span></button>
  <button id="measure" aria-pressed="false" aria-label="Измерить расстояние">${icon('ruler')}<span>Замер</span></button>
  <button id="toggle-inspector" aria-label="Свойства модели" aria-expanded="true" aria-controls="properties-panel">${icon('list')}<span>Свойства</span></button>
  <div class="rail-spacer"></div>
  <button id="file-settings" aria-label="Модель и параметры расчёта" title="Модель и параметры расчёта">${icon('sliders')}<span>Параметры</span></button>
  <button id="help" aria-label="Справка" title="Справка">${icon('info')}<span>Справка</span></button>
 </nav>
 <div class="workarea">
  <div class="error" id="error" role="alert" hidden></div>
  <div class="workspace">
   <aside class="model-tree" id="model-panel">
    <div class="panel-head"><h2>Состав модели</h2><button id="close-tree" class="icon-button" aria-label="Скрыть структуру">${icon('close')}</button></div>
    <div id="scene-members"></div><div class="tree-tools"><label class="search-field">${icon('search')}<input id="element-search" aria-label="Поиск элемента" type="search" placeholder="Имя, класс или ID"></label><label class="storey-picker">Этаж<select id="storey-filter"><option value="">Все этажи</option></select></label><label class="storey-picker">Система<select id="system-filter"><option value="">Все системы</option></select></label><label class="system-only-toggle"><input id="system-only" type="checkbox"><span>Только выбранная система</span></label><div id="system-summary" aria-live="polite"></div></div>
    <div id="element-tree"></div><button id="reset-visibility" class="reset-tree">${icon('fit')}Показать всю модель</button>
   </aside>
   <section class="scene" aria-label="Рабочая область модели">
    <div id="canvas"></div><div id="cad-host" hidden></div><div id="no-model"><strong>Добавьте модель проекта</strong><p>RVT или IFC — модель, системы и свойства.<br>DWG / DXF — просмотр чертежа.</p><button id="empty-add-model" class="add-model-primary">${icon('open')}Добавить модель</button><small>Файл обрабатывается на вашем устройстве</small></div>
    <div class="scene-tools"><button id="fit" title="Вписать модель · F" aria-label="Вписать модель">${icon('fit')}</button><button id="xray" aria-pressed="false" title="Прозрачная модель" aria-label="Прозрачная модель">${icon('layers')}</button></div>
    <div id="cut-controls" hidden><label>Ось сечения<select id="cut-axis" aria-label="Ось сечения"><option>Z</option><option>X</option><option>Y</option></select><output id="cut-height"></output><input id="cut-position" type="range" min="0" max="100" value="50" aria-label="Положение сечения"></label><label class="check"><input id="cut-reverse" type="checkbox">Обратная сторона</label><button id="cut-box">Область выбранного элемента</button></div><div id="measure-controls" hidden></div>
    <div class="scene-caption simulation-only"><span>Последовательность строительства</span><strong id="active-stage">Сценарий не выбран</strong></div>
    <div class="canvas-hint">Мышь — вращение <span>Правая кнопка — перемещение</span> · F — вписать</div>
   </section>
   <aside class="properties-panel" id="properties-panel"><div class="panel-head"><h2 id="inspector-title">Свойства модели</h2><button id="close-inspector" class="icon-button" aria-label="Скрыть свойства">${icon('close')}</button></div><div class="properties-scroll"><div class="inspector" id="inspector"></div><div class="inspector" id="resources"></div></div></aside>
  </div>
  <section class="simulation-dock simulation-only" aria-label="Управление симуляцией">
   <div class="playback">
    <span class="dock-label">4D<span>Ход строительства</span></span>
    <button id="play" aria-label="Воспроизвести" class="primary" disabled>▶</button><button id="rewind" aria-label="В начало" disabled>↶</button>
    <select id="rate" aria-label="Скорость"><option value="1">1×</option><option value="10">10×</option><option value="60" selected>60×</option><option value="240">240×</option></select>
    <select id="scenes" aria-label="Сцена работ"><option value="">Выберите этап</option></select>
    <span id="clock">0 мин</span><input id="time" type="range" min="0" max="1" value="0" aria-label="Виртуальное время" disabled>
    <details class="view-options"><summary title="Отображение и обход модели">${icon('sliders')}</summary><div><button id="tour" aria-pressed="false">Автопоказ</button><button id="worker-route">Путь бригады</button><label class="check"><input id="site" type="checkbox" checked>Площадка</label><label class="check"><input id="show-complete" type="checkbox" checked>Будущие элементы</label></div></details>
    <select id="time-unit" aria-label="Единицы шкалы"><option value="days">Сутки</option><option value="hours">Часы</option><option value="minutes">Минуты</option></select>
    <select id="timeline-zoom" aria-label="Масштаб графика"><option value="1">1:1</option><option value="2">2×</option><option value="4">4×</option></select>
    <button id="toggle-schedule" aria-label="Показать график" aria-expanded="true" aria-controls="schedule-panel">${icon('list')}</button>
   </div>
   <section class="schedule-panel" id="schedule-panel">
    <div class="gantt-scroll"><div id="gantt" aria-label="Расчётный график работ"><div id="gantt-ruler"></div><div id="gantt-body"></div></div></div>
    <div class="export-actions"><span id="schedule-summary">Нет выбранного расчёта</span><a id="csv" hidden>CSV</a><a id="journal" hidden>JSON</a><button id="schedule-details-toggle" aria-expanded="false" aria-controls="schedule-details">Основания и длительности</button></div>
    <div id="schedule-details" hidden><div class="metrics" id="metrics"></div><div class="schedule-wrap"><table><thead><tr><th>Работа</th><th>Начало / конец, мин</th><th>Ход работ</th><th>Основание</th></tr></thead><tbody id="schedule"></tbody></table></div></div>
   </section>
  </section>
 </div>
</main>
<footer class="status-bar"><span class="status-indicator" aria-hidden="true"></span><span id="workspace-status" role="status">Загрузка</span><button id="status-details">Подробности</button><span class="privacy-label">Обработка на устройстве</span><span class="formats">DWG / RVT / IFC</span></footer>
<dialog id="file-dialog" aria-labelledby="file-dialog-title"><div class="panel-head"><h2 id="file-dialog-title">Файл и параметры</h2><button id="close-file" class="icon-button" aria-label="Закрыть параметры">${icon('close')}</button></div><div class="dialog-content"><label>Проект<select id="projects" aria-label="Проект"></select></label><label>Сохранённый сценарий<select id="runs" aria-label="Рассчитанный сценарий"></select></label><label>Сохранённая модель<select id="models" aria-label="Пространственная модель"></select></label><div id="import-host"></div><details class="notes simulation-only"><summary>Допущения и покрытие</summary><div id="assumptions">Нет выбранного расчёта.</div></details></div></dialog>
<dialog id="help-dialog" aria-labelledby="help-title"><div class="panel-head"><h2 id="help-title">Работа с моделью</h2><button id="close-help" class="icon-button" aria-label="Закрыть справку">${icon('close')}</button></div><div class="dialog-content"><p>Откройте DWG, DXF, RVT или IFC. Выберите элемент на модели или в структуре — его свойства появятся справа.</p><dl><dt>Вращение</dt><dd>Левая кнопка мыши</dd><dt>Перемещение</dt><dd>Правая кнопка или стрелки</dd><dt>Масштаб</dt><dd>Колесо мыши</dd><dt>Вписать модель</dt><dd>F при фокусе на холсте</dd><dt>Снять выделение</dt><dd>Escape при фокусе на холсте</dd></dl><div class="notice">Расчётный сценарий содержит допущения и не заменяет ПОС/ППР.</div><p>RVT читается частично. DWG/DXF доступны для просмотра чертежей; симуляция рассчитывается по IFC/RVT.</p></div></dialog>`;
