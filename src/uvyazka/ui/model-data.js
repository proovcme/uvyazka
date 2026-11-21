/* Search and build tables against the same saved file snapshots as MCP. */
globalThis.UvyazkaModelData = (() => {
  const sections = {
    elements:'Элементы', types:'Типы', systems:'Системы', levels:'Уровни', layers:'Слои',
    blocks:'Блоки', layouts:'Листы CAD', views:'Виды', schedules:'Спецификации', relationships:'Связи',
  };
  const labels = {
    name:'Название', category:'Категория', native_id:'ID в исходнике', properties:'Свойства',
    identifiers:'Идентификаторы', parent:'Родитель', level:'Уровень', layer:'Слой',
    saved_metadata:'Сохранённые данные RVT', mep_system:'Инженерная система', root_fields:'Поля записи RVT',
    attributes:'Атрибуты', property_sets:'Наборы свойств', element_id:'Revit ElementId',
    unique_id:'Revit UniqueId', global_id:'IFC GlobalId', native_guid:'Navisworks GUID', handle:'CAD Handle',
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const valueText = value => value === null ? 'null' : value === '' ? 'Пустая строка' :
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  const pretty = value => typeof value === 'boolean' ? (value ? 'Да' : 'Нет') : valueText(value);
  const preciseJson = text => JSON.parse(text, (_, value, context) =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) &&
    /^[+-]?\d+$/.test(context?.source ?? '') ? context.source : value);
  const option = (value, text) => new Option(text, value);
  const date = value => new Date(value).toLocaleString('ru-RU');
  const pathLabel = path => path.map(key => labels[key] ?? key).join(' / ');

  function mount(host, project) {
    const root = document.createElement('div');
    root.className = 'model-workbench';
    root.innerHTML = '<section class="panel"><div class="panel-head"><h2>Источник</h2></div>' +
      '<div class="model-workbench-sources"><div><form data-files class="model-workbench-controls"><label>Поиск файла<input type="search" maxlength="256" name="q" placeholder="Имя или путь"></label><button class="button">Найти файл</button></form>' +
      '<div class="model-workbench-controls"><label>Файл проекта<select data-files-list></select></label><button type="button" class="button" data-read>Прочитать данные</button></div>' +
      '<div class="model-workbench-pages"><button type="button" data-file-prev>Назад</button><button type="button" data-file-next>Далее</button></div></div>' +
      '<div><div class="model-workbench-controls"><label>Сохранённый снимок<select data-datasets></select></label></div>' +
      '<div class="model-workbench-pages"><button type="button" data-dataset-prev>Назад</button><button type="button" data-dataset-next>Далее</button></div>' +
      '<p data-source-summary class="model-workbench-note"></p><details class="ui-diagnostics" data-diagnostics hidden><summary>Охват и источник</summary><pre></pre></details></div></div>' +
      '<p class="model-workbench-status" data-source-status role="status"></p></section>' +
      '<section class="panel" data-results hidden><div class="panel-head"><h2>Таблица данных</h2></div>' +
      '<form data-search class="toolbar model-workbench-controls"><label>Раздел<select data-section></select></label><label>Поиск в данных<input data-query type="search" maxlength="256" placeholder="Имя, ID, свойство или значение"></label><button class="button">Найти в данных</button></form>' +
      '<details class="model-workbench-columns"><summary>Колонки</summary><p>Откройте свойства строки, чтобы добавить нужное поле.</p><ol data-columns></ol></details>' +
      '<div class="table-wrap" data-table></div><div class="table-meta"><span data-result-status role="status"></span><div class="pagination"><button data-prev>Назад</button><button data-next>Далее</button></div></div>' +
      '<div class="model-workbench-export"><button class="button" data-export="csv">Скачать CSV</button><button class="button" data-export="json">Скачать JSON</button><span data-export-status role="status"></span></div></section>' +
      '<dialog data-object class="model-workbench-object" aria-labelledby="model-workbench-object-title"><div class="panel-head"><h2 id="model-workbench-object-title">Свойства строки</h2><button type="button" class="button" data-close>Закрыть</button></div><div data-object-content></div></dialog>';
    host.replaceChildren(root);
    const $ = selector => root.querySelector(selector);
    const fileSelect = $('[data-files-list]');
    const sourceStatus = $('[data-source-status]');
    const datasets = $('[data-datasets]');
    const section = $('[data-section]');
    const query = $('[data-query]');
    const dialog = $('[data-object]');
    const tableHost = $('[data-table]');
    const output = $('[data-export-status]');
    const resultStatus = $('[data-result-status]');
    const exportButtons = [...root.querySelectorAll('[data-export]')];
    let dataset, columns, fileQuery = '', fileOffset = 0, datasetOffset = 0, filesRun = 0, datasetRun = 0, rowsRun = 0, detailRun = 0;
    let nextFile, nextDataset, nextCursor, cursors = [], search = '', busyRead = false, busyExport = false, rowsReady = false;

    const endpoint = (path, args = {}) => '/api/models/' + path + '?' + new URLSearchParams({project_id:project,...args});
    async function request(path, args, options, blob = false) {
      const url = endpoint(path, args);
      if (url.length > 60000) throw Error('Для просмотра сократите заголовки или выберите меньше колонок.');
      const response = await fetch(url, options);
      if (!response.ok) throw Error((await response.json()).error || 'Ошибка запроса');
      return blob ? response.blob() : response.json();
    }
    let statusPromise;
    const status = () => statusPromise ??= request('status').catch(error => {statusPromise = null; throw error;});
    async function post(path, data) {
      const config = await status();
      return request(path, {}, {method:'POST', headers:{'Content-Type':'application/json','X-Uvyazka-Token':config.write_token}, body:JSON.stringify(data)});
    }
    const message = (target, text) => {target.textContent = text; target.setAttribute('role','status');};
    const fail = (target, error, fallback) => UvyazkaLanguage.showError(target, error, fallback);
    function fileButtons(loading = false) {
      $('[data-read]').disabled = busyRead || loading || !fileSelect.value;
      $('[data-file-prev]').disabled = loading || fileOffset === 0;
      $('[data-file-next]').disabled = loading || nextFile == null;
    }
    async function loadFiles() {
      const run = ++filesRun;
      fileButtons(true);
      try {
        const {items,next_offset} = await request('documents', {q:fileQuery,offset:fileOffset});
        if (!root.isConnected || run !== filesRun) return;
        nextFile = next_offset;
        fileSelect.replaceChildren(...items.map(file => option(file.doc_id, file.relative_path)));
        if (!items.length) fileSelect.append(option('', 'Подходящих файлов нет'));
      } catch (error) {
        if (run !== filesRun) return;
        nextFile = null;
        fileSelect.replaceChildren(option('', 'Список файлов недоступен'));
        fail(sourceStatus, error, 'Не удалось загрузить список файлов проекта.');
      } finally {
        if (run === filesRun) fileButtons();
      }
    }
    async function loadDatasets(preferred) {
      const run = ++datasetRun;
      try {
        const {items,next_offset} = await request('datasets',{offset:datasetOffset});
        if (!root.isConnected || run !== datasetRun) return;
        nextDataset = next_offset;
        const selected = preferred ?? dataset;
        if (selected && !items.some(item => item.dataset_id === selected.dataset_id)) items.unshift(selected);
        datasets.replaceChildren(...items.map(item => option(item.dataset_id,
          (item.source.relative_path || 'Сцена ' + item.source.scene_id) + ' · ' + date(item.created_at))));
        if (!items.length) datasets.append(option('', 'Сохранённых снимков пока нет'));
        if (selected) datasets.value = selected.dataset_id;
        datasets.onchange = () => activate(items.find(item => item.dataset_id === datasets.value));
        if (preferred || !dataset) activate(items.find(item => item.dataset_id === datasets.value));
      } catch (error) {
        if (run === datasetRun) fail(sourceStatus, error, 'Не удалось загрузить сохранённые снимки.');
      }
      $('[data-dataset-prev]').disabled = datasetOffset === 0;
      $('[data-dataset-next]').disabled = nextDataset == null;
    }
    const closeObject = () => {detailRun++; if (dialog.open) dialog.close();};
    function activate(item) {
      closeObject();
      dataset = item;
      $('[data-results]').hidden = !item;
      if (!item) return;
      const changed = ['needs_refresh','different_registered_version','source_unavailable'].includes(item.freshness.status);
      $('[data-source-summary]').textContent = [
        item.object_count.toLocaleString('ru-RU') + ' прочитанных записей',
        item.coverage.status === 'partial' ? 'Покрытие частичное' : '',
        item.coverage.profile_failures?.some?.(profile => profile.profile === 'views') ? 'Виды и спецификации не прочитаны' : '',
        changed ? 'Оригинал изменён или недоступен' : '',
        item.source.original_file_reopened === false ? 'Данные из сохранённой сцены' : '',
      ].filter(Boolean).join(' · ');
      $('[data-diagnostics]').hidden = false;
      $('[data-diagnostics] pre').textContent = JSON.stringify({source:item.source,coverage:item.coverage}, null, 2);
      section.replaceChildren(...Object.entries(sections).map(([key,title]) => option(key, title + ' · ' + (item.counts[key] ?? 0))));
      section.value = Object.keys(sections).find(key => item.counts[key]) || 'elements';
      query.value = search = '';
      columns = [{title:'Название',path:['name']},{title:'Категория',path:['category']},{title:'ID в исходнике',path:['native_id']}];
      refreshColumns();
      resetRows();
    }
    function definition() {
      return {section:section.value, query:search, search_properties:true, columns};
    }
    function exportState() {
      for (const button of exportButtons) button.disabled = !rowsReady || busyExport;
    }
    function resetRows() {
      cursors = [null];
      message(output, '');
      void loadRows();
    }
    async function loadRows() {
      const run = ++rowsRun;
      const {columns,section,query} = definition();
      const args = {dataset_id:dataset.dataset_id, section, q:query, search_properties:1, columns:JSON.stringify(columns),limit:30};
      const cursor = cursors.at(-1);
      if (cursor) args.cursor = cursor;
      rowsReady = false;
      exportState();
      $('[data-prev]').disabled = $('[data-next]').disabled = true;
      tableHost.replaceChildren();
      message(resultStatus, 'Ищем в снимке…');
      try {
        let page, scanned = 0;
        do {
          page = await request('query', args);
          if (!root.isConnected || run !== rowsRun) return;
          scanned += page.scanned;
          if (page.items.length || !page.next_cursor) break;
          args.cursor = page.next_cursor;
          message(resultStatus, 'Проверено записей: ' + scanned.toLocaleString('ru-RU'));
        } while (true);
        if (!root.isConnected || run !== rowsRun) return;
        nextCursor = page.next_cursor;
        const cell = data => data.status === 'absent' ? '—' : data.status === 'preview' ? data.text + '…' : pretty(preciseJson(data.json_text));
        tableHost.innerHTML = '<table><thead><tr><th scope="col">Источник строки</th>' +
          columns.map(column => '<th scope="col">' + esc(column.title) + '</th>').join('') + '</tr></thead><tbody>' +
          page.items.map((row,index) => '<tr><th scope="row"><button type="button" class="source-button" data-row="' + index +
            '">Свойства</button></th>' + row.cells.map(data => '<td>' + esc(cell(data)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
        tableHost.querySelectorAll('[data-row]').forEach(button => {
          button.onclick = () => void openObject(page.items[Number(button.dataset.row)]);
        });
        const pageText = page.items.length ? 'Строк на странице: ' + page.items.length : 'Совпадений в этой выборке снимка нет';
        message(resultStatus, pageText + (page.next_cursor ? ' · поиск можно продолжить' : ''));
        rowsReady = true;
        $('[data-prev]').disabled = cursors.length <= 1;
        $('[data-next]').disabled = nextCursor == null;
      } catch (error) {
        if (run !== rowsRun) return;
        $('[data-prev]').disabled = cursors.length <= 1;
        fail(resultStatus, error, 'Не удалось прочитать строки таблицы.');
      } finally {
        if (run === rowsRun) exportState();
      }
    }
    function refreshColumns() {
      const list = $('[data-columns]');
      list.replaceChildren();
      columns.forEach((column,index) => {
        const item = document.createElement('li');
        item.innerHTML = '<label><span>' + esc(pathLabel(column.path)) + '</span><input maxlength="200" aria-label="Заголовок колонки" value="' +
          esc(column.title) + '"></label><button type="button" class="button" aria-label="Переместить выше">↑</button><button type="button" class="button" aria-label="Переместить ниже">↓</button><button type="button" class="button" aria-label="Удалить колонку">×</button>';
        const input = item.querySelector('input');
        input.onchange = () => {
          input.value = input.value.trim() || column.title;
          if (input.value === column.title) return;
          column.title = input.value;
          resetRows();
        };
        const [up,down,remove] = item.querySelectorAll('button');
        up.disabled = index === 0;
        down.disabled = index === columns.length-1;
        remove.disabled = columns.length === 1;
        const move = delta => {
          columns.splice(index+delta,0,columns.splice(index,1)[0]);
          refreshColumns(); resetRows();
          list.children[index+delta].querySelector('input').focus();
        };
        up.onclick = () => move(-1);
        down.onclick = () => move(1);
        remove.onclick = () => {
          columns.splice(index,1); refreshColumns(); resetRows();
          list.children[Math.min(index,columns.length-1)].querySelector('input').focus();
        };
        list.append(item);
      });
    }
    function renderFields(target, fields, statusLine, path = []) {
      const entries = Array.isArray(fields) ? fields.map((value,index) => [index,value]) : Object.entries(fields);
      const list = document.createElement('ul');
      target.append(list);
      function appendPage(offset) {
        for (const [key,value] of entries.slice(offset,offset+50)) {
          const fieldPath = [...path,key], label = labels[key] ?? String(key);
          const line = document.createElement('li');
          const nested = value !== null && typeof value === 'object';
          const add = document.createElement('button');
          add.type = 'button'; add.className = 'button'; add.textContent = '+ В таблицу';
          add.setAttribute('aria-label','Добавить поле ' + pathLabel(fieldPath) + ' в таблицу');
          add.onclick = () => {
            if (columns.some(column => JSON.stringify(column.path) === JSON.stringify(fieldPath))) {
              message(statusLine, 'Поле уже в таблице.'); return;
            }
            if (columns.length >= 32 || fieldPath.length > 32 || JSON.stringify(fieldPath).length > 500) {
              message(statusLine, 'Не удалось добавить поле. Допустимо до 32 колонок с короткими путями.'); return;
            }
            columns.push({title:pathLabel(fieldPath).slice(0,200),path:fieldPath});
            $('[data-columns]').closest('details').open = true;
            refreshColumns(); resetRows();
            message(statusLine, 'Колонка добавлена.');
          };
          if (nested) {
            const group = document.createElement('details');
            const title = document.createElement('summary');
            title.textContent = label;
            group.append(title,add);
            group.addEventListener('toggle', () => {
              if (group.open && !group.querySelector('ul')) renderFields(group,value,statusLine,fieldPath);
            });
            line.append(group);
          } else {
            const text = document.createElement('span');
            text.textContent = label + ' · ' + pretty(value);
            line.append(text,add);
          }
          list.append(line);
        }
        if (offset+50 < entries.length) {
          const more = document.createElement('button');
          more.type = 'button'; more.className = 'button'; more.textContent = 'Ещё поля';
          more.onclick = () => {more.remove(); appendPage(offset+50);};
          target.append(more);
        }
      }
      appendPage(0);
    }
    async function openObject(row) {
      const run = ++detailRun;
      const current = dataset;
      const content = $('[data-object-content]');
      content.textContent = 'Читаем свойства и источник…';
      if (!dialog.open) dialog.showModal();
      try {
        const pieces = [];
        let offset = 0;
        do {
          const next = await request('object', {dataset_id:current.dataset_id,object_id:row.object_id,offset,max_chars:12000});
          if (run !== detailRun || !root.isConnected || !dialog.open) return;
          pieces.push(next.text);
          offset = next.next_offset;
        } while (offset !== null);
        const raw = pieces.join('');
        const data = preciseJson(raw);
        content.innerHTML = '<h3>' + esc(data.name || 'Запись ' + data.native_id) + '</h3><p>' + esc(current.source.relative_path || current.source.scene_id) +
          ' · ID ' + esc(data.native_id) + '</p><p data-added role="status"></p><div class="model-workbench-fields"></div><details class="ui-diagnostics"><summary>Адрес источника и исходные данные</summary><pre></pre></details>';
        const {object_id,section,diagnostics,evidence,quantity_eligible,semantic_kind,value_semantics,...fields} = data;
        renderFields(content.querySelector('.model-workbench-fields'),fields,content.querySelector('[data-added]'));
        content.querySelector('pre').textContent = ['Снимок ' + current.dataset_id, 'SHA-256 ' + current.source.sha256, raw].join('\n');
      } catch (error) {
        if (run === detailRun) fail(content, error, 'Не удалось прочитать свойства строки.');
      }
    }
    async function download(format) {
      if (busyExport || !rowsReady) return;
      const run = rowsRun;
      busyExport = true; exportState();
      message(output, 'Строим таблицу по всему снимку…');
      try {
        const table = await post('table', {request_id:crypto.randomUUID(),dataset_id:dataset.dataset_id,definition:definition()});
        if (run !== rowsRun || !root.isConnected) return;
        const blob = await request('table/export',{table_id:table.table_id,format},undefined,true);
        if (run !== rowsRun || !root.isConnected) return;
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url; link.download = 'model-table-' + table.table_id.slice(0,12) + '.' + format;
        root.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        message(output, 'Строк в выгрузке: ' + table.row_count.toLocaleString('ru-RU'));
      } catch (error) {
        if (run !== rowsRun) return;
        const fallback = /Table budget/i.test(error.message) ? 'Слишком большая таблица. Уточните поиск или уменьшите число колонок.' : 'Не удалось подготовить таблицу.';
        fail(output, error, fallback);
      } finally {
        busyExport = false; exportState();
      }
    }
    $('[data-files]').onsubmit = event => {
      event.preventDefault(); fileOffset = 0; fileQuery = event.target.elements.q.value.trim(); void loadFiles();
    };
    $('[data-file-prev]').onclick = () => {fileOffset = Math.max(0,fileOffset-40); void loadFiles();};
    $('[data-file-next]').onclick = () => {fileOffset = nextFile; void loadFiles();};
    $('[data-dataset-prev]').onclick = () => {datasetOffset = Math.max(0,datasetOffset-20); void loadDatasets();};
    $('[data-dataset-next]').onclick = () => {datasetOffset = nextDataset; void loadDatasets();};
    $('[data-read]').onclick = async () => {
      if (busyRead || !fileSelect.value) return;
      const id = fileSelect.value;
      busyRead = true; fileButtons();
      message(sourceStatus, 'Читаем данные файла…');
      try {
        const item = await post('read', {request_id:crypto.randomUUID(),doc_id:id});
        if (!root.isConnected) return;
        datasetOffset = 0; await loadDatasets(item);
        message(sourceStatus, 'Снимок сохранён в проекте.');
      } catch (error) {
        fail(sourceStatus,error,'Не удалось прочитать файл. Проверьте наличие локального читателя и поддержку версии формата.');
      } finally {
        busyRead = false; fileButtons();
      }
    };
    $('[data-search]').onsubmit = event => {event.preventDefault(); search = query.value.trim(); resetRows();};
    section.onchange = () => {search = query.value.trim(); resetRows();};
    $('[data-prev]').onclick = () => {cursors.pop(); void loadRows();};
    $('[data-next]').onclick = () => {cursors.push(nextCursor); void loadRows();};
    $('[data-close]').onclick = closeObject;
    dialog.addEventListener('cancel',() => {detailRun++;});
    for (const button of exportButtons) button.onclick = () => void download(button.dataset.export);
    void loadFiles();
    void loadDatasets();
  }
  return {mount};
})();
