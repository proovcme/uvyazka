const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const groupNames = {tep:'ТЭП',rooms:'Помещения',capacity:'ТУ и мощности',quantities:'Объёмы',finance:'Финансы',organization:'Организация'};
const statusNames = {matches:'Совпадает',question:'Нужна сверка',not_comparable:'Недостаточно данных',needs_review:'Нужно пересмотреть'};
const processingNames = {text_indexed:'Текст извлечён',pending:'Ожидает обработки',unsupported:'Нужен отдельный читатель',source_missing:'Источник отсутствует',parse_failed:'Ошибка чтения',empty_text:'Нет извлечённого текста'};
const freshnessNames = {snapshot_metadata_matches:'Размер и время файла совпадают со снимком',content_hash_matches:'Содержимое совпадает по хешу',historical_snapshot:'Сохранённая прежняя версия',stale_version:'Версия источника изменилась',needs_refresh:'Нужно обновить источник',source_unavailable:'Источник недоступен'};
const unitNames = {m:'м',mm:'мм',cm:'см',km:'км',m2:'м²',m3:'м³',ha:'га',kg:'кг',t:'т',piece:'шт.',kW:'кВт',W:'Вт','m3/day':'м³/сут','l/s':'л/с','10 m2':'10 м²','1000 m2':'1000 м²','100 m3':'100 м³'};
function unit(value) { return unitNames[value] || value; }
function basis(value) { return ({same_scope:'Одна область измерения',site_boundary:'В границах участка',net:'Чистый объём',supply:'Объём поставки'})[value] || value; }
function explanation(c) {
  if (c.status === 'needs_review') return 'Изменилось исходное наблюдение или его источник. Сопоставление нужно проверить заново.';
  const exact = {'Compared with explicit units and semantic scope. This is not engineering acceptance.':'Сопоставлены значения с одинаковой областью измерения и приведёнными единицами. Результат требует инженерной проверки.','Different material/size/specification':'Различаются материал, размер или спецификация.','Missing value is not zero':'Одно из значений отсутствует. Пропуск нельзя считать нулём.','Units need an explicit compatible conversion':'Нужно проверить единицы и задать допустимое преобразование.'};
  if (exact[c.explanation]) return exact[c.explanation];
  const fields = {entity:'объект измерения',property:'свойство',basis:'основание измерения',revision_set:'набор ревизий'};
  for (const [key,name] of Object.entries(fields)) {
    if (c.explanation === 'Missing semantic field: ' + key) return 'Не указано: ' + name + '.';
    if (c.explanation === 'Different ' + key) return 'Различается ' + name + '.';
  }
  return c.explanation;
}
function locatorName(l) {
  if (l.kind === 'pdf_page') return 'Страница PDF: ' + l.pdf_page;
  if (l.kind === 'excel_row') return `Лист «${l.sheet}», строка ${l.row}, ячейки: ${(l.cells || []).map(c=>c.cell).join(', ')}`;
  if (l.kind === 'docx_paragraph') return 'Абзац документа: ' + l.paragraph;
  if (l.kind === 'docx_table_row') return `Таблица ${l.table}, строка ${l.row}`;
  return 'Строка: ' + (l.line || l.row || '—');
}
let current = '', projects = [], facts = [], checks = [], status = {}, view = 'overview', offset = 0, timer, generation = 0, resultGeneration = 0;
const routes = {overview:'Обзор проекта',facts:'Все показатели',rooms:'Помещения',capacity:'ТУ и мощности',quantities:'Объёмы и материалы',finance:'Финансы',checks:'Сопоставления',coordination:'Увязка разделов',simulation:'График и модель',documents:'Документы',search:'Поиск по тексту',portfolio:'Все проекты'};
function url(path) { const u = new URL(path, location.origin); u.searchParams.set('project_id', current); return u.pathname + u.search; }
async function api(path) { const r = await fetch(path === '/api/projects' ? path : url(path)); const d = await r.json(); if (!r.ok) throw Error(d.error); return d; }
function badge(s) { return `<span class="badge ${esc(s)}">${esc(statusNames[s] || s)}</span>`; }
function number(value) { if (value == null) return '—'; return typeof value === 'object' ? esc(JSON.stringify(value)) : esc(value); }
function sourceButton(f) { return `<button class="source-button" data-fact="${esc(f.id)}">Источник ↗</button>`; }
function panel(title, content) { return `<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div>${content}</section>`; }
function factTable(items) { return items.length ? `<div class="table-wrap"><table><thead><tr><th>Показатель</th><th>Значение</th><th>Основание</th><th>Источник</th></tr></thead><tbody>${items.map(f => `<tr><td class="fact-name">${esc(f.name)}<span class="fact-id">${esc(f.id)} · ${esc(groupNames[f.group] || f.group)}</span></td><td class="num">${number(f.value)} ${esc(unit(f.unit))}</td><td class="basis">${esc(basis(f.basis))}</td><td>${sourceButton(f)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">В этой выборке наблюдений пока нет.</div>'; }
function issueList(items) { return items.map(c => `<article class="issue-card">${badge(c.status)}<h3>${esc(c.title)}</h3><p>${esc(explanation(c))}</p>${c.difference !== undefined ? `<p>Разница в базовой единице: ${esc(c.difference)}</p>` : ''}${c.fact_ids.map(id => `<button class="source-button" data-fact="${esc(id)}">${esc(id)} ↗</button>`).join(' · ')}</article>`).join('') || '<div class="empty">Нет сохранённых сопоставлений.</div>'; }
function filterBar(placeholder) { return `<div class="toolbar"><label class="search"><span class="sr-only">Поиск</span><input id="query" placeholder="${esc(placeholder)}" aria-label="Поиск"></label></div>`; }
async function loadProject(id) {
  const revision = ++generation; clearTimeout(timer); current = id; $('#detail').close();
  const u = new URL(location.href); u.searchParams.set('project', id); history.replaceState(null, '', u);
  const data = await Promise.all([api('/api/status'),api('/api/facts'),api('/api/checks')]); if (revision !== generation) return;
  [status,{facts},{checks}] = data; $('#project-select').value = id;
  $('#project-name').textContent = status.project.name; document.title = status.project.name + ' — Увязка';
  $('#snapshot').textContent = new Date(status.snapshot.snapshot_created).toLocaleString('ru-RU');
  $('#coverage').textContent = `Сохранено наблюдений: ${facts.length}. Не все числа извлечены; действующие ревизии и инженерные выводы требуют проверки.`;
  await route();
}
async function route() {
  view = location.hash.slice(1) || 'overview'; if (!routes[view]) view = 'overview'; offset = 0;
  $('#page-title').textContent = routes[view];
  $('#navigation').innerHTML = Object.entries(routes).map(([key,title]) => `<a href="#${key}" class="nav-item ${key === view ? 'active' : ''}">${esc(title)}</a>`).join('');
  $('#section-select').innerHTML = Object.entries(routes).map(([key,title]) => `<option value="${key}" ${key === view ? 'selected' : ''}>${esc(title)}</option>`).join('');
  if (view === 'portfolio') {
    $('#view').innerHTML = panel('Реестр проектов', `<div class="table-wrap"><table><thead><tr><th>Объект</th><th>Документы</th><th>Наблюдения</th><th></th></tr></thead><tbody>${projects.map(p => `<tr><td>${esc(p.name)}<span class="fact-id">${esc(p.id)} · ${esc(p.location)}</span></td><td>${p.counts?.documents ?? '—'}</td><td>${p.counts?.facts ?? '—'}</td><td><button class="source-button" data-project="${esc(p.id)}">Открыть →</button></td></tr>`).join('')}</tbody></table></div>`); return;
  }
  if (view === 'overview') {
    const count = status.counts;
    $('#view').innerHTML = `<div class="kpis">${[[count.documents,'Документов'],[count.pages,'Страниц / блоков'],[facts.length,'Наблюдений'],[checks.filter(c => c.status !== 'matches').length,'Вопросов']].map(([n,t]) => `<div class="kpi"><span class="kpi-label">${t}</span><strong class="kpi-value">${n}</strong></div>`).join('')}</div>` + panel(status.project.name, `<div class="identity"><p>${esc(status.project.location)}</p></div>`) + panel('Основные показатели', factTable(facts.filter(f => f.group === 'tep').slice(0,6))) + panel('Есть вопросы к данным', issueList(checks.filter(c => c.status !== 'matches'))) + panel('Покрытие извлечения', `<div class="detail-info">${Object.entries(status.coverage).map(([key,n]) => `<p>${esc(processingNames[key] || key)}: ${n}</p>`).join('')}<p>Статус обработки документа не подтверждает полноту или правильность инженерных показателей.</p></div>`); return;
  }
  if (view === 'simulation') {
    $('#view').innerHTML = panel('График и пространственная модель', `<div class="detail-info"><p>Расчёт работ с ресурсными ограничениями, воспроизведение и основания длительностей. Геометрия может быть условной.</p><a class="source-button" href="/simulation/?project=${encodeURIComponent(current)}">Открыть график и модель →</a></div>`); return;
  }
  if (view === 'coordination') {
    const key = current; const data = await api('/api/coordination/audits'); if (key !== current || view !== 'coordination') return;
    if (!data.items.length) { $('#view').innerHTML = panel('Общая согласованность проекта', '<div class="empty">Нет сохранённых проверок. Агенту нужно собрать объекты и требования проекта и вызвать audit_project_graph.</div>'); return; }
    const audit = data.items.at(-1); $('#view').innerHTML = panel('Покрытие проверки', `<div class="detail-info"><p>Ревизия графа: ${audit.revision}. Объектов: ${audit.entity_count}. Вопросов: ${audit.issue_count}.</p><p>Рассмотрено документов из заданного состава: ${audit.coverage.reviewed_expected_documents} / ${audit.coverage.expected_documents}.</p><p>Разделы, ожидающие разбора: ${esc(audit.coverage.missing_disciplines.join(', ') || 'В заданном составе отсутствуют')}.</p><p>${esc(audit.interpretation)}</p><p>Проверка относится к переданным данным. Полнота проекта не подтверждена.</p></div>`) + panel('Вопросы по связям и требованиям', '<div id="coordination-issues"></div>');
    $('#coordination-issues').dataset.audit = audit.audit_id; await loadCoordinationIssues(); return;
  }
  if (view === 'checks') { $('#view').innerHTML = panel('Сохранённые сопоставления', issueList(checks)); return; }
  if (view === 'documents' || view === 'search') {
    $('#view').innerHTML = panel(routes[view], filterBar(view === 'documents' ? 'Название или шифр документа…' : 'Марка, система или ключевые слова…') + '<div id="results"></div>');
    $('#query').addEventListener('input', () => { clearTimeout(timer); offset = 0; timer = setTimeout(loadResults, 250); });
    await loadResults(); return;
  }
  const selected = facts.filter(f => view === 'facts' || f.group === view);
  $('#view').innerHTML = panel(routes[view], filterBar('Название, номер или значение…') + '<div id="facts-table">' + factTable(selected) + '</div>');
  $('#query').addEventListener('input', e => { const q = e.target.value.toLowerCase(); $('#facts-table').innerHTML = factTable(selected.filter(f => `${f.id} ${f.name} ${f.value}`.toLowerCase().includes(q))); });
}
async function loadResults() {
  const key = current, routeKey = view, q = $('#query')?.value || '', request = ++resultGeneration; if (!$('#results')) return;
  try {
    if (view === 'search') {
      if (!q) { $('#results').innerHTML = '<div class="empty">Поиск по тексту не заменяет полный обход таблиц. Сканы без OCR могут не попасть в выдачу.</div>'; return; }
      const data = await api('/api/search?q=' + encodeURIComponent(q)); if (key !== current || routeKey !== view || request !== resultGeneration) return;
      $('#results').innerHTML = data.results.map(r => `<article class="search-result"><h3>${esc(r.relative_path)}</h3><p>${esc(r.snippet)}</p><button class="source-button" data-source="${esc(JSON.stringify({doc_id:r.doc_id,sha256:r.sha256,parser_revision:r.parser_revision,page_number:r.page_number}))}">Читать источник ↗</button></article>`).join('') || '<div class="empty">Ничего не найдено.</div>';
    } else {
      const data = await api(`/api/documents?q=${encodeURIComponent(q)}&offset=${offset}`); if (key !== current || routeKey !== view || request !== resultGeneration) return;
      $('#results').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Документ</th><th>Обработка</th><th></th></tr></thead><tbody>${data.documents.map(d => `<tr><td class="file-name">${esc(d.relative_path)}<span class="fact-id">${esc(d.doc_id)}</span></td><td>${esc(processingNames[d.index_status] || d.index_status)}${d.error ? '<small class="fact-id">' + esc(d.error) + '</small>' : ''}</td><td>${d.index_status === 'text_indexed' ? `<button class="source-button" data-source="${esc(JSON.stringify({doc_id:d.doc_id,sha256:d.sha256,parser_revision:d.parser_revision,page_number:1}))}">Открыть ↗</button>` : ''}</td></tr>`).join('')}</tbody></table></div><div class="table-meta">Всего ${data.total}<div class="pagination"><button data-page="prev" ${offset ? '' : 'disabled'}>Назад</button><button data-page="next" ${data.next_offset === null ? 'disabled' : ''}>Далее</button></div></div>`;
    }
  } catch (e) { if ($('#results') && key === current && routeKey === view && request === resultGeneration) $('#results').textContent = e.message; }
}
function show(content) { $('#detail-body').innerHTML = content; if (!$('#detail').open) $('#detail').showModal(); }
function openFact(id) {
  const f = facts.find(item => item.id === id); if (!f) return;
  show(`<h2 id="detail-title">${esc(f.name)}</h2><div class="detail-value">${number(f.value)} <small>${esc(unit(f.unit))}</small></div><p>${esc(basis(f.basis))}</p><div class="detail-info">Наблюдение из источника · ревизия ${f.revision}. Инженерно не принято.${Object.values(f.source_freshness).some(s => s !== 'snapshot_metadata_matches') ? '<p>Источник изменился или недоступен.</p>' : ''}</div><h3>Источники</h3>${f.sources.map(s => `<div class="source-item"><strong>${esc(s.doc_id)}</strong> · страница/блок ${s.page_number}<div><button class="source-button" data-source="${esc(JSON.stringify(s))}">Показать данные</button></div></div>`).join('')}<div id="source-preview"></div>`);
}
async function openSource(s, nextOffset = 0) {
  if (!$('#detail').open) show(`<h2 id="detail-title">Источник</h2><div id="source-preview"></div>`);
  if (!$('#source-preview')) $('#detail-body').insertAdjacentHTML('beforeend', '<div id="source-preview"></div>');
  const key = current, target = $('#source-preview'); target.innerHTML = '<p>Читаем источник…</p>';
  try {
    const parser = s.parser_revision ? '&parser_revision=' + encodeURIComponent(s.parser_revision) : '';
    const data = await api(`/api/source?doc_id=${encodeURIComponent(s.doc_id)}&sha256=${encodeURIComponent(s.sha256)}&page=${s.page_number}&offset=${nextOffset}${parser}`); if (key !== current || !target.isConnected) return;
    const imageUrl = url(`/api/page-image?doc_id=${encodeURIComponent(s.doc_id)}&sha256=${encodeURIComponent(s.sha256)}&page=${data.locator.pdf_page || 1}`);
    target.innerHTML = `<div class="detail-info"><strong>${esc(data.source_path)}</strong><p>${esc(locatorName(data.locator))}</p><p>Свежесть: ${esc(freshnessNames[data.freshness.status] || data.freshness.status)}</p></div><pre class="source-text">${esc(data.text)}</pre>${data.next_offset ? `<button class="source-button" data-next-source="${esc(JSON.stringify({...s,offset:data.next_offset}))}">Следующий фрагмент →</button>` : ''}${data.locator.kind === 'pdf_page' ? `<details><summary>Изображение страницы</summary><img class="source-image" loading="lazy" src="${imageUrl}" alt="Страница ${data.locator.pdf_page} исходного PDF"></details>` : ''}`;
  } catch (e) { target.textContent = e.message; }
}
async function loadCoordinationIssues() {
  const target = $('#coordination-issues'); if (!target) return; const key = current;
  const data = await api('/api/coordination/issues?audit_id=' + encodeURIComponent(target.dataset.audit) + '&offset=' + offset);
  if (key !== current || !target.isConnected) return;
  target.innerHTML = (data.graph_changed ? '<div class="empty">Граф изменён: проверку нужно повторить.</div>' : '') + (data.changed_documents?.length ? '<div class="empty">Источники изменились; отчёт исторический: '+esc(data.changed_documents.join(', '))+'</div>' : '') + data.items.map(i=>`<article class="issue-card"><span class="badge question">Вопрос</span><h3>${esc(i.message)}</h3><p>${esc(i.entity_id || 'Проект')} ${esc(i.port_id || '')} ${esc(i.mode || '')}</p><small>${esc(i.code)}</small>${i.sources?.length ? `<details><summary>Основания</summary><pre>${esc(JSON.stringify(i.sources,null,2))}</pre></details>`:''}</article>`).join('') + `<div class="table-meta">Всего вопросов: ${data.total}<div class="pagination"><button data-coord-page="prev" ${offset ? '' : 'disabled'}>Назад</button><button data-coord-page="next" ${data.next_offset === null ? 'disabled' : ''}>Далее</button></div></div>`;
}
document.addEventListener('click', e => { const b=e.target.closest('[data-coord-page]'); if(b){offset=Math.max(0,offset+(b.dataset.coordPage==='next'?40:-40));loadCoordinationIssues().catch(showError);} });
document.addEventListener('click', e => { const b = e.target.closest('[data-fact],[data-source],[data-next-source],[data-project],[data-page]'); if (!b) return; if (b.dataset.fact) openFact(b.dataset.fact); else if (b.dataset.source) openSource(JSON.parse(b.dataset.source)); else if (b.dataset.nextSource) {const s=JSON.parse(b.dataset.nextSource);openSource(s,s.offset);} else if (b.dataset.project) {location.hash='overview';loadProject(b.dataset.project).catch(showError);} else {offset=Math.max(0,offset+(b.dataset.page==='next'?30:-30));loadResults();} });
function showError(e) { $('#view').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
$('#project-select').addEventListener('change', e => loadProject(e.target.value).catch(showError));
$('#section-select').addEventListener('change', e => location.hash = e.target.value);
$('#close-detail').addEventListener('click', () => $('#detail').close());
window.addEventListener('hashchange', () => route().catch(showError));
(async () => { try { const data = await api('/api/projects'); projects = data.projects; if (!projects.length) {$('#coverage').textContent='Проекты не зарегистрированы.';$('#view').innerHTML='<div class="empty">Для начала выполните uvyazka demo или зарегистрируйте свою папку командой add-project.</div>';return;} $('#project-select').innerHTML=projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''); await loadProject(new URL(location.href).searchParams.get('project') || data.default_project); } catch(e) {showError(e);} })();
