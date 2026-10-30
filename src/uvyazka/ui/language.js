/* Engineers see result/action first; exact errors stay in native collapsed
   details. Reuse paper/ink surfaces, inherited body type and existing spacing. */
globalThis.UvyazkaLanguage = (() => {
  const rawMessage = value => value instanceof Error ? value.message : String(value?.message ?? value ?? '');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function userMessage(value, fallback='Не удалось выполнить действие. Подробности доступны в диагностике.') {
    const text = rawMessage(value);
    if (/Failed to fetch|NetworkError|Load failed|ECONNREFUSED|HTTP 5\d\d/i.test(text)) return 'Не удалось связаться с сервисом. Проверьте подключение и повторите действие.';
    if (/native record framing is unvalidated for Revit (\d{4})/i.test(text)) return `Эта версия RVT пока не поддерживается: Revit ${/Revit (\d{4})/.exec(text)?.[1]}.`;
    if (/revision conflict|source (?:fingerprint )?changed|refresh.*reread/i.test(text)) return 'Исходные данные изменились. Обновите их и повторите действие.';
    if (/ENOENT|FileNotFoundError|source unavailable|source root unavailable/i.test(text)) return 'Исходный файл или папка недоступны. Проверьте доступ к оригиналам и повторите действие.';
    if (/budget|allocation|out of memory|memory access out of bounds|exceeds.*(?:MiB|bytes)/i.test(text)) return 'Не удалось прочитать все данные файла. Подробности доступны в диагностике.';
    if (/(?:\bm_\w+|\bDBView\w*|\bTableCellStyle\b|\bgraph\b|\bschema\b|\bwasm\b|\bworker\b|\bstack\b|\bCFB\b|\bscaffold\b|\bconfidence_level\b|\bbuilding_elements\b|\bSHA-256\b|\b[A-Za-z]*Error\b|SQLITE_|Traceback|Unexpected token|0x[\da-f]{6,}|at \d{5,}|\b(?:source_hashes|request_id|record_id|doc_id|dataset_id|extraction_id)\b)/i.test(text) || /^[\x00-\x7f]+$/.test(text) && /[a-zA-Z]{3}/.test(text)) return fallback;
    return text || fallback;
  }
  function errorHtml(value, fallback) {
    const raw = rawMessage(value), readable = userMessage(value, fallback);
    return `<span>${escape(readable)}</span>` + (raw && raw !== readable ? `<details class="ui-diagnostics"><summary>Диагностика</summary><pre>${escape(raw)}</pre></details>` : '');
  }
  function showError(target, value, fallback) {
    target.innerHTML = errorHtml(value, fallback);
    target.setAttribute('role', 'alert');
  }
  const classLabels={DocumentElement:'Элемент по документации',IfcBuildingStorey:'Уровень',IfcSystem:'Система',IfcDistributionSystem:'Инженерная система',IfcValve:'Арматура',IfcCableSegment:'Кабель',IfcCableCarrierSegment:'Лоток или короб',IfcLightFixture:'Светильник',IfcElectricDistributionBoard:'Электрический щит',IfcSensor:'Датчик',IfcSanitaryTerminal:'Санитарный прибор',IfcWall:'Стена',IfcWallStandardCase:'Стена',IfcSlab:'Плита',IfcRoof:'Кровля',IfcDoor:'Дверь',IfcWindow:'Окно',IfcColumn:'Колонна',IfcBeam:'Балка',IfcMember:'Элемент конструкции',IfcPlate:'Пластина',IfcCurtainWall:'Витраж',IfcStair:'Лестница',IfcStairFlight:'Лестничный марш',IfcRailing:'Ограждение',IfcCovering:'Отделка',IfcFooting:'Фундамент',IfcPile:'Свая',IfcSpace:'Помещение',IfcPump:'Насос',IfcFan:'Вентилятор',IfcDuctSegment:'Воздуховод',IfcDuctFitting:'Фасонная деталь воздуховода',IfcPipeSegment:'Труба',IfcPipeFitting:'Фасонная деталь трубы',IfcFlowTerminal:'Конечное устройство',IfcFlowController:'Регулирующее устройство',IfcDistributionElement:'Инженерное оборудование',IfcBuildingElementProxy:'Элемент модели',IfcFurnishingElement:'Оборудование и мебель',FamilyInstance:'Элемент Revit',RbsDuctCurve:'Воздуховод',RbsPipeCurve:'Труба',NwdFragment:'Элемент модели',lcatfconsumer_Mesh:'Элемент модели','Pipes':'Трубы','Ducts':'Воздуховоды','Pipe Fittings':'Соединительные детали труб','Duct Fittings':'Соединительные детали воздуховодов','Generic Models':'Обобщённые модели','Mechanical Equipment':'Механическое оборудование','Air Terminals':'Воздухораспределители','Pipe Accessories':'Арматура трубопроводов','Duct Accessories':'Арматура воздуховодов','Flex Ducts':'Гибкие воздуховоды','Flex Pipes':'Гибкие трубы'};
  function displayClass(value) {const name=String(value??'').replace(/^Класс RVT:\s*/,'');return classLabels[name]??(/^(?:Ifc|DBView|Rbs|LcOa|LcOp|lcatf)/.test(name)?'Элемент модели':name||'Элемент модели');}
  return {userMessage, rawMessage, errorHtml, showError, displayClass};
})();
