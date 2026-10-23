import {initTheme} from './theme';
import {federate} from './federation';
import {systemMembers,systemCoverage,elementSystems} from './systems';
import type {SceneMember} from './federation';
import {spatialPanel} from './spatial-panel';
import { workspaceShell, icon } from './workspace-shell';
import {timelineRows,timeLabel} from './timeline';
import type {TimelineUnit} from './timeline';
import './style.css';
import './appearance.css';
import { browserPanel } from './browser-panel';
import type { BrowserRun } from './browser-panel';
import { workScenes } from './scenes';
import {rvtDocumentPanel} from './rvt-document-panel';
import {viewOrientation} from './rvt-document';
import {modelDataPanel} from './model-data-panel';
import {elementIdentity,elementLabelMatches} from './element-identity';
import {installPropertyCopy,copyValue} from './copy-properties';
import {ModelVisibility} from './model-visibility';
import {modelTreePanel} from './model-tree-panel';
import {parameterCatalog,parametersMatch} from './parameter-search';
import type {ParameterOperator,ParameterFilter} from './parameter-search';
import {facetFilter} from './facet-filter';
import {elementCategory} from './element-category';
import {cadTreePanel} from './cad-tree-panel';
import type {CadTreeState} from './cad-tree-panel';
const DEMO = import.meta.env.VITE_UVYAZKA_DEMO === '1';
import { Viewer } from './viewer';
import type { BimElement,ModelPackage } from './model';
import { PlaybackClock, projectState } from './simulation';
import type { RunPackage } from './simulation';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let browserModel:ModelPackage|null=null, browserBinary:ArrayBuffer|null=null, browserRun:BrowserRun|null=null;
const browserUrls:string[]=[];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let selectedId:string|null=null;
let workspaceMode: "view"|"simulate" = "view", cadFrame:HTMLIFrameElement|null=null;
let project = new URL(location.href).searchParams.get('project') || '';
let measurementProject=project||'browser-local';
let sceneMembers:SceneMember[]=[],loadedBinary:ArrayBuffer|null=null;
let sceneVersion=0;
let requestedModel = new URL(location.href).searchParams.get('model') || '';
let requestedRun = new URL(location.href).searchParams.get('run') || '';
let viewer: Viewer | null = null, model: ModelPackage | null = null, run: RunPackage | null = null, clock: PlaybackClock | null = null, frame = 0, last = 0, generation = 0, modelGeneration = 0;
const visibility=new ModelVisibility();let visibilityModelId='',treeItems:BimElement[]=[];
let parameterFilters:ParameterFilter[]=[];
document.getElementById('app')!.innerHTML = workspaceShell;
const tree=modelTreePanel(el('element-tree'),visibility,{select:id=>{selectElement(id);viewer?.focusTargets([id]);},show:setElementVisibility,isolate:isolateElements});
const levelFacet=facetFilter(el<HTMLDetailsElement>('level-filter'),'Уровни',applySceneVisibility);
const categoryFacet=facetFilter(el<HTMLDetailsElement>('category-filter'),'Категории',applySceneVisibility);
initTheme();
installPropertyCopy();
modelDataPanel(()=>model,id=>{selectElement(id);viewer?.focusTargets([id]);});
const documentPanel=DEMO?rvtDocumentPanel(record=>{
  const orientation=viewOrientation(record);if(!orientation||!viewer||!model)return;
  setMode('view');el('reset-visibility').click();viewer.orient(orientation.direction,orientation.up);
  el('workspace-status').textContent='Ориентация вида · реконструкция без оформления, обрезки и фильтров Revit';
},()=>{setMode('view');el('reset-visibility').click();}):null;

function path(route: string) {
  if(DEMO) { const [key,query='']=route.split('?');const q=new URLSearchParams(query);
    if(key==='models'||key==='runs')return './demo/'+key+'.json';
    if(key==='model')return './demo/model-'+q.get('model_id')+'.json';
    if(key==='geometry.bin')return './demo/geometry-'+q.get('model_id')+'.bin';
    if(key==='run')return './demo/run-'+q.get('run_id')+'.json';
    if(key==='schedule.csv')return './demo/schedule-'+q.get('run_id')+'.csv';
    throw Error('В демо доступны сохранённые модели и расчёты.');
  }
 const u = new URL('/api/construction/' + route, location.origin); u.searchParams.set('project_id', project); return u.pathname + u.search; }
async function api<T>(route: string): Promise<T> { const response = await fetch(path(route)); const data = await response.json(); if (!response.ok) throw Error(data.error); return data; }
function error(e: unknown) { el('error').hidden = false; el('error').textContent = e instanceof Error ? e.message : String(e); }
function selectElement(id: string | null) {
  selectedId=id;el('resources').innerHTML='';
  el('selected-visibility-actions').hidden=!id;
  if(id){tree.reveal(id);el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=!visibility.visible(id);}
  viewer?.select(id);document.querySelectorAll<HTMLElement>('.element-item').forEach(row=>row.setAttribute('aria-pressed',String(row.dataset.id===id)));if(id)setPanel('inspector',true); const e = model?.elements.find(e => e.id === id);
  el('selected-visibility-actions').hidden=!e||e.role!=='element';
  if (!e) { renderState(); return; }
  el('inspector-title').textContent = e.name;
  const identity=elementIdentity(e),systems=elementSystems(model,e.id);
  const renderSets=(sets:Record<string,Record<string,unknown>>)=>Object.entries(sets).map(([name,values])=>`<details class="property-set" open><summary>${esc(name)}</summary><dl>${Object.entries(values).map(([key,value])=>`<dt>${esc(key)}</dt><dd>${copyValue(value)}</dd>`).join('')}</dl></details>`).join('');
  const card={...e,revit_identity:identity,systems,model_source:model?.source};
  el('inspector').innerHTML = `<span class="eyebrow">${esc(e.class)}</span><button class="copy-card" data-copy="${esc(JSON.stringify(card,null,2))}">Копировать все свойства</button><dl><dt>Revit ElementId</dt><dd>${identity.element_id?copyValue(identity.element_id):'Не прочитан'}</dd><dt>Revit UniqueId</dt><dd>${identity.unique_id?copyValue(identity.unique_id):'Не прочитан'}</dd><dt>IFC / ID сцены</dt><dd>${copyValue(e.id)}</dd><dt>Этаж</dt><dd>${copyValue(model?.storeys.find(s=>s.id===e.storey_id)?.name||'Не прочитан')}</dd><dt>Материалы</dt><dd>${copyValue(e.materials.join(', ')||'Не прочитаны')}</dd></dl><p class="identity-basis">${esc(identity.basis)}</p>${renderSets(e.quantity_sets)}${renderSets(e.property_sets)}<details><summary>Идентификаторы и источник</summary><dl><dt>IFC GlobalId</dt><dd>${e.global_id?copyValue(e.global_id):'Не прочитан'}</dd><dt>Исходный Tag</dt><dd>${e.tag?copyValue(e.tag):'Не прочитан'}</dd></dl><pre>${esc(JSON.stringify(e.source,null,2))}</pre></details>`;
  el('inspector').innerHTML+=`<details open><summary>Системы: ${systems.length}</summary>${systems.map(s=>`<p>${esc(s.name||s.class)} · #${esc(s.id)}</p>`).join('')||'<p>Принадлежность к системе не прочитана.</p>'}<p>Членство не подтверждает физическое подключение.</p></details>`;
}
try { viewer = new Viewer(el('canvas'), selectElement); } catch(e) { error('3D недоступно; график и расчёты остаются доступны. ' + String(e)); }
const spatial=spatialPanel(viewer,()=>model,()=>measurementProject,error);
el('canvas').addEventListener('viewer-error', ((e: CustomEvent<string>) => error(e.detail)) as EventListener);
async function loadModel(id: string) {
  const token = ++modelGeneration; spatial.reset();selectedId=null;el('selected-visibility-actions').hidden=true;viewer?.select(null); viewer?.setSite(null);clipped=false;el('cut-controls').hidden=true;el('cut').setAttribute('aria-pressed','false');el('xray').setAttribute('aria-pressed','false');
  if (!id) { model = null;loadedBinary=null;visibility.reset();visibilityModelId='';el('file-title').textContent='Модель не выбрана'; el('no-model').hidden = false; el('geometry-kind').textContent = 'Без геометрии'; viewer?.show(new Set<string>());renderModelTree();renderState();return; }
  const [pkg, binary] = browserModel?.model_id===id&&browserBinary ? [browserModel,browserBinary] : await Promise.all([api<ModelPackage>('model?model_id=' + encodeURIComponent(id)), fetch(path('geometry.bin?model_id=' + encodeURIComponent(id))).then(async r => {if(!r.ok) throw Error('Не удалось загрузить геометрию');return r.arrayBuffer();})]);
  if (token !== modelGeneration) return;
  model = pkg;loadedBinary=binary;if(visibilityModelId!==pkg.model_id){visibility.reset();visibilityModelId=pkg.model_id;visibility.set(pkg.elements.filter(e=>!sceneVisible(e.source_instance_id)).map(e=>e.id),false);} el("workspace-status").textContent=`${pkg.statistics.physical_elements} элементов · ${pkg.storeys.length} уровней${pkg.source.schema==='SyntheticDemo'?' · Учебная модель':''}`; el("file-title").textContent=pkg.source.filename; renderModelTree(); viewer?.load(pkg,binary); viewer?.setSourceColors(pkg.source.schema!=='SyntheticDemo'); document.dispatchEvent(new Event('model-data-changed')); applySceneVisibility(); el('no-model').hidden = true;
  el('geometry-kind').textContent = pkg.source.schema === 'SyntheticDemo' ? 'Синтетическая сводная модель · АР + ОВ' : pkg.source.schema === 'DocumentSpatialModel' ? 'Условная геометрия по документам' : pkg.federation ? 'Сводная геометрия · совмещение требует проверки' : pkg.source.format==='rvt' ? 'RVT → IFC · экспериментальная геометрия' : 'Геометрия IFC'; renderState();
}
async function loadRun(id: string) {
  const token = ++generation; touring=false;el('tour').setAttribute('aria-pressed','false'); if (clock) clock.playing = false;
  run = null; clock = null;
  for (const key of ['metrics','schedule','resources','gantt-body','gantt-ruler']) el(key).innerHTML = '';
  for (const key of ['csv','journal']) { el(key).hidden = true; el(key).removeAttribute('href'); }
  for (const key of ['play','rewind','time']) (el(key) as HTMLButtonElement).disabled = true;
  el('clock').textContent = '0 мин'; el<HTMLInputElement>('time').value = '0';
  el('assumptions').textContent = 'Нет выбранного расчёта.';renderGantt();
  if (!id) { renderState(); return; }
  const data = browserRun?.run_id===id ? browserRun : await api<BrowserRun>('run?run_id=' + encodeURIComponent(id));
  if (token !== generation) return;
  run = data; clock = new PlaybackClock(run.duration); clock.rate = Number(el<HTMLSelectElement>('rate').value);
  el<HTMLInputElement>('time').max = String(run.duration); el<HTMLInputElement>('time').disabled = false; el<HTMLButtonElement>('play').disabled = false; el<HTMLButtonElement>('rewind').disabled = false;
  el('metrics').innerHTML = [[run.scenario.operations.length,'Работ'],[run.duration,'Расчётных минут'],[data.cpm.duration_minutes,'Минут по одним связям'],[run.events.filter(e=>e.kind==='resource_wait').length,'Ожиданий ресурсов']].map(([n,s])=>`<article><strong>${n}</strong><span>${s}</span></article>`).join('');
  for (const [key,route] of [['csv','schedule.csv'],['journal','run']]) { el<HTMLAnchorElement>(key).href = browserRun?.run_id===run.run_id ? browserDownload(key,run) : path(route+'?run_id='+encodeURIComponent(run.run_id)); el(key).hidden = false; }
  el('assumptions').innerHTML = run.scenario.assumptions.map(s=>`<p>${esc(s)}</p>`).join('') + `<p>Элементов вне графа работ: ${run.scenario.unplanned_element_ids.length}. Статус расчёта: ${esc(run.status)}.</p>`;
  el('schedule').innerHTML = run.scenario.operations.map(o=> {const s=run!.operation_states[o.id]; const critical=data.cpm.operations[o.id].critical; return `<tr data-operation="${esc(o.id)}"><td><strong>${critical?'<span class="critical" title="Критическая по связям">●</span> ':''}<button class="schedule-jump" type="button">${esc(o.name)}</button></strong><small>${esc(o.id)} · ${esc(o.dependencies.join(', ') || 'Начальная работа')}</small></td><td>${s.start ?? '—'} → ${s.finish ?? '—'}</td><td><div class="track"><i style="left:${(s.start||0)/Math.max(1,run!.duration)*100}%;width:${o.duration/Math.max(1,run!.duration)*100}%"></i></div></td><td><span>${esc(o.evidence.kind === 'assumed' ? 'Допущение' : 'С источником')}</span><small>${esc(o.evidence.reason)}</small></td></tr>`;}).join('');
  renderGantt();
  const modelId = run.scenario.model_id || ''; el<HTMLSelectElement>('models').value = modelId; await loadModel(modelId); el<HTMLSelectElement>('scenes').innerHTML='<option value="">Выберите сцену</option>'+ (model?workScenes(run,model):[]).map((s,i)=>`<option value="${i}">${esc(s.title)}</option>`).join(''); renderState();
}
function renderState() {
  if(workspaceMode==='view') {
    viewer?.setSite(null);viewer?.setConstruction(null);el('resources').innerHTML='';
    if(selectedId)return;
    el('inspector-title').textContent=cadFrame?'Чертёж':'Свойства модели';
    el('inspector').innerHTML=cadFrame?'<p>DWG / DXF: просмотр чертежа, масштабирование и слои.</p><p>Для строительной симуляции нужна модель с элементами и объёмами. Чертёж сам по себе их не подтверждает.</p>':model?`<p><strong>${esc(model.source.filename)}</strong></p><dl><dt>Физических элементов / с геометрией</dt><dd>${model.statistics.physical_elements} / ${model.statistics.meshes}</dd><dt>Уровней</dt><dd>${model.storeys.length}</dd><dt>Источник</dt><dd>${esc(model.source.format==='rvt'?'RVT → '+model.source.schema:model.source.schema)}</dd></dl><p>Выберите элемент на модели или в структуре, чтобы увидеть свойства и количества.</p>`:'<p>Откройте DWG, DXF, RVT или IFC.</p>';
    return;
  }
  if(!selectedId)el('inspector-title').textContent = 'Ход строительства';
  if (!run || !clock) {el('active-stage').textContent='Сценарий не рассчитан';viewer?.setConstruction(null);if(selectedId)return;el('inspector').innerHTML='<p>Модель открыта. Подготовьте сценарий кнопкой «Рассчитать» или с помощью агента.</p>'; return;}
  const tick = clock.time, state = projectState(run,tick);
  el('gantt').style.setProperty('--playhead',Math.min(100,tick/Math.max(1,run.duration)*100)+'%');
  el('active-stage').textContent=state.active.length?state.active[0].name+(state.active.length>1?' · ещё '+(state.active.length-1):''):tick>=run.duration?'Сценарий завершён':'Ожидание начала работ';
  viewer?.setConstruction(state.construction, el<HTMLInputElement>('show-complete').checked);
  if(model?.model_id===run.scenario.model_id) viewer?.setSite(el<HTMLInputElement>('site').checked?run:null,tick);
  el('clock').textContent = Math.floor(tick)+' мин'; el<HTMLInputElement>('time').value = String(tick);
  el('play').textContent=clock.playing?'Ⅱ':'▶'; el('play').setAttribute('aria-label',clock.playing?'Пауза':'Воспроизвести');
  if(!selectedId){
  el('inspector').innerHTML=`<p><strong>${state.completed} / ${run.scenario.operations.length}</strong> работ завершено по графику</p><h3>Назначения по графику</h3>${state.active.map(o=>`<p>${esc(o.name)}</p>`).join('')||'<p>Нет активных работ</p>'}<h3>Ожидают ресурсы</h3>${state.waiting.map(o=>`<p>${esc(o.name)}</p>`).join('')||'<p>Нет ожидающих работ</p>'}`;
  el('resources').innerHTML='<h3>Ресурсы</h3>'+run.scenario.resources.map(r=>`<label>${esc(r.name)}<strong>${state.resources.get(r.id)||0} / ${r.capacity}</strong><progress value="${state.resources.get(r.id)||0}" max="${r.capacity}"></progress></label>`).join('');
  const site=el<HTMLInputElement>('site').checked?viewer?.siteState():null;
  if(site) {
    const workers=site.actors.flatMap(a=>a.workers??[]).filter(w=>w.visible);
    const count=(phases:string[])=>workers.filter(w=>phases.includes(w.phase)).length;
    el('inspector').innerHTML+=`<h3>Действия работников</h3><p>Назначено: ${workers.length} · Подход / подъём: ${count(['approach','climb'])} · Работа у элемента: ${count(['work'])} · Уход: ${count(['depart'])} · Ожидание / блокировка: ${count(['waiting','blocked'])}.</p><p>Бирюзовая линия — маршрут. Жёлтая точка — место действия на элементе. Это проверка геометрии сценария, не подтверждение выполненных работ.</p><details><summary>Задания и доступ</summary>${workers.map(w=>`<p><strong>${esc(w.action)}</strong> — ${esc(w.targetName)}${w.targetId?' (#'+esc(w.targetId)+')':''}${w.reason?'<br>'+esc(w.reason):''}${w.routeBasis.some(b=>b.includes('assumed')||b.includes('proposed'))?'<br>Временный доступ — допущение сценария.':''}</p>`).join('')}</details>`;
    if(site.warnings.length)el('inspector').innerHTML+=`<details open><summary>Требуют решения: ${site.warnings.length}</summary>${site.warnings.map(w=>`<p>${esc(w.message)}</p>`).join('')}</details>`;
  }
  }
  document.querySelectorAll<HTMLElement>('[data-operation]').forEach(row=>row.dataset.state=state.states.get(row.dataset.operation!)||'pending');
}
async function loadProject(id:string,skipModel=false) {
  measurementProject=id;
  ++sceneVersion;sceneMembers=[];renderMembers();++generation; ++modelGeneration; touring=false;el('tour').setAttribute('aria-pressed','false'); if(clock) clock.playing=false; project=id; el('error').hidden=true;
  el<HTMLAnchorElement>('back').href=DEMO?'https://locia.work/':'/?project='+encodeURIComponent(id); if(DEMO)el('back').textContent='locia.work ↗'; if(!DEMO)el<HTMLAnchorElement>('memory-link').href=el<HTMLAnchorElement>('back').href;
  el('measurement-link').hidden=DEMO;
  if(!DEMO)el<HTMLAnchorElement>('measurement-link').href='/measurements/?project='+encodeURIComponent(id);
  history.replaceState(null,'','?project='+encodeURIComponent(id));
  const key=project; const [models,runs]=await Promise.all([api<{items:{model_id:string;name:string}[]}>('models'),api<{items:{run_id:string;scenario_id:string;scenario_revision:number;duration_minutes:number;name?:string}[]}>('runs')]); if(key!==project)return;
  el<HTMLSelectElement>('models').innerHTML='<option value="">Без геометрии</option>'+models.items.map(m=>`<option value="${esc(m.model_id)}">${esc(m.name)}</option>`).join('');
  el<HTMLSelectElement>('runs').innerHTML='<option value="">Выберите расчёт</option>'+runs.items.map(r=>`<option value="${esc(r.run_id)}">${esc(r.name||r.scenario_id)} · ревизия ${r.scenario_revision} · ${r.duration_minutes} мин</option>`).join('');
  if(skipModel){await loadRun('');return;}
  const requested=runs.items.find(r=>r.run_id===requestedRun);
  if(requested){el<HTMLSelectElement>('runs').value=requested.run_id;await loadRun(requested.run_id);}
  else if(models.items.some(m=>m.model_id===requestedModel)){el<HTMLSelectElement>('models').value=requestedModel;await loadRun('');await loadModel(requestedModel);}
  else if(runs.items.length&&!DEMO){el<HTMLSelectElement>('runs').value=runs.items.at(-1)!.run_id; await loadRun(runs.items.at(-1)!.run_id);} else {await loadRun(''); await loadModel(models.items[0]?.model_id||'');el<HTMLSelectElement>('models').value=models.items[0]?.model_id||'';}
  requestedModel='';requestedRun='';
}
let touring=false,tourIndex=0,tourElapsed=0;
function showScene(index:number) {if(!run||!model||!clock)return; const scenes=workScenes(run,model); const s=scenes[index];if(!s)return;el<HTMLSelectElement>('scenes').value=String(index);clock.seek(s.start);renderState();setSceneCut(s.cut??null);if(s.targetIds.length)viewer?.focusTargets(s.targetIds);else viewer?.fit();if(s.reference){viewer?.setConstruction(null);viewer?.setSite(null);}}
el('tour').addEventListener('click',()=>{if(!clock||!run||!model)return;touring=!touring;tourIndex=0;tourElapsed=0;clock.playing=touring;last=0;cancelAnimationFrame(frame);el('tour').setAttribute('aria-pressed',String(touring));if(touring){showScene(0);frame=requestAnimationFrame(animate);}else renderState();});
function animate(now:number) { frame=0;
 if(touring&&clock?.playing&&run&&model){const scenes=workScenes(run,model);tourElapsed+=last?(now-last)/1000:0;last=now;if(tourElapsed>=2.6){tourElapsed=0;tourIndex++;if(tourIndex>=scenes.length){touring=false;clock.playing=false;el('tour').setAttribute('aria-pressed','false');return;}showScene(tourIndex);}const s=scenes[tourIndex];clock.seek(s.start+(s.end-s.start)*tourElapsed/2.6);renderState();if(s.reference){viewer?.setConstruction(null);viewer?.setSite(null);}frame=requestAnimationFrame(animate);return;}
 if(!clock?.playing)return; if(last)clock.advance((now-last)/1000);last=now;renderState();if(clock.playing)frame=requestAnimationFrame(animate); }
el('projects').addEventListener('change',()=>void loadProject(el<HTMLSelectElement>('projects').value).catch(error));
el('runs').addEventListener('change',()=>void loadRun(el<HTMLSelectElement>('runs').value).catch(error));
el('models').addEventListener('change',()=>void loadModel(el<HTMLSelectElement>('models').value).catch(error));
el('play').addEventListener('click',()=>{touring=false;el('tour').setAttribute('aria-pressed','false');if(!clock)return;if(clock.time>=clock.duration)clock.seek(0);clock.playing=!clock.playing;last=0;cancelAnimationFrame(frame);renderState();if(clock.playing)frame=requestAnimationFrame(animate);});
el('rewind').addEventListener('click',()=>{touring=false;el('tour').setAttribute('aria-pressed','false');if(clock){clock.playing=false;clock.seek(0);renderState();}});
el('time').addEventListener('input',()=>{touring=false;el('tour').setAttribute('aria-pressed','false');if(clock){clock.playing=false;clock.seek(Number(el<HTMLInputElement>('time').value));renderState();}});
el('rate').addEventListener('change',()=>{if(clock)clock.rate=Number(el<HTMLSelectElement>('rate').value);});
el('worker-route').addEventListener('click',()=>{
  if(!clock||!run||!model)return;
  const selected=workScenes(run,model)[Number(el<HTMLSelectElement>('scenes').value)];
  const actors=viewer?.siteState()?.actors.filter(a=>a.active&&(a.workers?.length??0)>0)??[];
  const actor=actors.find(a=>a.operationId===selected?.operationId)??actors[0];if(!actor?.operationId)return;
  touring=false;el('tour').setAttribute('aria-pressed','false');clock.seek(run.operation_states[actor.operationId].start);
  clock.rate=10;el<HTMLSelectElement>('rate').value='10';clock.playing=true;last=0;cancelAnimationFrame(frame);
  renderState();viewer?.focusWorkerRoute(actor.operationId);frame=requestAnimationFrame(animate);
});
el('show-complete').addEventListener('change',renderState);
el('iso').addEventListener('click',()=>viewer?.fit('iso'));el('top').addEventListener('click',()=>viewer?.fit('top'));el('fit').addEventListener('click',()=>viewer?.fit());
document.addEventListener('visibilitychange',()=>{last=0;});
el('site').addEventListener('change',()=>{renderState();viewer?.fit();});
el('scenes').addEventListener('change',()=>{if(!run||!model||!clock)return;const i=el<HTMLSelectElement>('scenes').value;if(i==='')return;const s=workScenes(run,model)[Number(i)];touring=false;el('tour').setAttribute('aria-pressed','false');clock.playing=false;clock.seek((s.start+s.end)/2);renderState();setSceneCut(s.cut??null);if(s.targetIds.length)viewer?.focusTargets(s.targetIds);else viewer?.fit();if(s.reference){viewer?.setConstruction(null);viewer?.setSite(null);}});
let clipped=false;
function setSceneCut(height:number|null){
  el<HTMLSelectElement>('cut-axis').value='Z';el<HTMLInputElement>('cut-reverse').checked=false;clipped=height!==null;
  const bounds=viewer?.modelHeight();
  if(height!==null&&bounds)el<HTMLInputElement>('cut-position').value=String(Math.max(0,Math.min(100,(height-bounds.min)/Math.max(.001,bounds.max-bounds.min)*100)));
  updateCut();
}
function updateCut(){
  const axis=el<HTMLSelectElement>('cut-axis').value as 'X'|'Y'|'Z';
  const value=clipped?viewer?.section(axis,Number(el<HTMLInputElement>('cut-position').value)/100,el<HTMLInputElement>('cut-reverse').checked):undefined;
  if(!clipped)viewer?.cutaway(null);
  el('cut-controls').hidden=!clipped;el('cut').setAttribute('aria-pressed',String(clipped));el('cut-height').textContent=value===undefined?'':value.toFixed(2)+' м';
}
el('cut').addEventListener('click',()=>{clipped=!clipped;updateCut();});
el('cut-position').addEventListener('input',updateCut);
el('cut-axis').onchange=updateCut;el('cut-reverse').onchange=updateCut;
el('cut-box').onclick=()=>{if(!viewer?.sectionBox(true))error('Выберите элемент для ограничения области');else el('cut-height').textContent='Область + 50 мм';};
el('xray').onclick=()=>{const active=el('xray').getAttribute('aria-pressed')!=='true';el('xray').setAttribute('aria-pressed',String(active));viewer?.setXray(active,model?.elements??[]);};
document.body.classList.add('viewer-app','schedule-open');document.body.dataset.mode='view';
if(DEMO){const downloads=document.createElement('a');downloads.href='./downloads/';downloads.textContent='Исходники';el('back').before(downloads);el('back').hidden=true;document.body.classList.add('public-demo');el<HTMLAnchorElement>('memory-link').href='https://github.com/proovcme/uvyazka';document.querySelector('.notice')!.textContent='Учебная модель. Откройте свой файл для просмотра или перейдите в «Симуляцию», чтобы изучить сценарий строительства.';}
function setMode(mode:'view'|'simulate') {
  if(mode==='simulate'&&cadFrame){error('DWG открыт как чертёж. Для симуляции загрузите IFC или RVT с геометрией и рассчитайте сценарий.');return;}
  spatial.reset();workspaceMode=mode;document.body.dataset.mode=mode;
  el('mode-view').setAttribute('aria-pressed',String(mode==='view'));el('mode-simulate').setAttribute('aria-pressed',String(mode==='simulate'));
  if(clock)clock.playing=false;touring=false;last=0;cancelAnimationFrame(frame);el('tour').setAttribute('aria-pressed','false');
  setPanel('tree',!matchMedia('(max-width: 650px)').matches);setPanel('inspector',!matchMedia('(max-width: 950px)').matches);
  applySceneVisibility();
  renderState();if(mode==='view')viewer?.fit();
}
el('mode-view').onclick=()=>setMode('view');el('mode-simulate').onclick=()=>setMode('simulate');
function sceneVisible(instance:string|undefined){return !instance?(sceneMembers.length!==1||sceneMembers[0].visible):sceneMembers.find(m=>m.instanceId===instance)?.visible!==false;}
function applySceneVisibility(){
  if(cadFrame)return;
  renderElements();const filtered=el<HTMLInputElement>('visibility-filter').checked?new Set(treeItems.map(e=>e.id)):null;
  viewer?.show(new Set((model?.elements??[]).filter(e=>e.role==='element'&&visibility.visible(e.id)&&(!filtered||filtered.has(e.id))).map(e=>e.id)));
  viewer?.highlightElements(systemMembers(model,el<HTMLSelectElement>('system-filter').value));
}
async function presentMembers(members:SceneMember[]){
  const version=++sceneVersion;
  if(!members.length){sceneMembers=[];browserModel=null;browserBinary=null;browserRun=null;await loadRun('');await loadModel('');renderMembers();document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:null}));return;}
  // A single untransformed member keeps its original IDs for existing schedules.
  const only=members[0],single=members.length===1&&only.offset.every(n=>n===0)&&only.rotation===0;
  const result=single?{model:only.model,binary:only.binary}:await federate(members);if(version!==sceneVersion)return;
  sceneMembers=members;browserModel=result.model;browserBinary=result.binary;browserRun=null;
  await loadRun('');el<HTMLSelectElement>('runs').innerHTML='<option>Сценарий не рассчитан</option>';
  el<HTMLSelectElement>('models').innerHTML=`<option value="${esc(result.model.model_id)}">${esc(result.model.source.filename)}</option>`;
  await loadModel(result.model.model_id);viewer?.setSourceColors(members.length>1);applySceneVisibility();
}
function renderMembers(){
  const host=el('scene-members');host.replaceChildren();if(!DEMO)return;
  const add=document.createElement('button');add.textContent='+ Добавить модель';add.className='add-scene-model';add.onclick=()=>{el<HTMLInputElement>('browser-append').checked=true;el<HTMLInputElement>('browser-file').click();};host.append(add);
  if(!sceneMembers.length)return;
  const note=document.createElement('p');note.textContent=sceneMembers.length>1?'Общие координаты · совмещение не подтверждено':'Исходные координаты модели';host.append(note);
  for(const member of sceneMembers){
    const row=document.createElement('details');row.className='scene-member';
    const summary=document.createElement('summary');summary.textContent=member.model.source.filename;row.append(summary);
    const visible=document.createElement('input');visible.type='checkbox';const ids=memberElementIds(member.instanceId);const state=visibility.count(ids);visible.checked=state.checked;visible.indeterminate=state.mixed;
    const label=document.createElement('label');label.className='check';label.append(visible,document.createTextNode('Показывать модель'));row.append(label);
    visible.onchange=()=>{member.visible=visible.checked;setElementVisibility(ids,visible.checked);};
    const coords=document.createElement('div');coords.className='placement-fields';const inputs:HTMLInputElement[]=[];
    for(const [i,name] of ['X, м','Y, м','Z, м','Угол Z, °'].entries()){const field=document.createElement('label');field.textContent=name;const input=document.createElement('input');input.type='number';input.step='any';input.value=String(i<3?member.offset[i]:member.rotation);input.setAttribute('aria-label',name+' · '+member.model.source.filename);inputs.push(input);field.append(input);coords.append(field);}row.append(coords);
    const apply=document.createElement('button');apply.textContent='Применить размещение';apply.onclick=()=>{const values=inputs.map(i=>i.value.trim()===''?NaN:Number(i.value));if(!values.every(Number.isFinite)){error('Заполните X, Y, Z и угол конечными числами');return;}void presentMembers(sceneMembers.map(m=>m===member?{...m,offset:[values[0],values[1],values[2]],rotation:values[3]}:m)).then(()=>document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:browserModel}))).catch(error);};row.append(apply);
    const remove=document.createElement('button');remove.textContent='Убрать из сцены';remove.onclick=()=>{void presentMembers(sceneMembers.filter(m=>m!==member)).then(()=>document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:browserModel}))).catch(error);};row.append(remove);
    const metadata=document.createElement('small');metadata.textContent=`${member.model.statistics.physical_elements} элементов · SHA-256 ${member.model.source.sha256.slice(0,12)}…`;row.append(metadata);host.append(row);
  }
}
function renderModelTree() {
  el('parameter-names').replaceChildren(...(model&&(el('parameter-search-details') as HTMLDetailsElement).open?parameterCatalog(model):[]).map(name=>new Option(name,name)));
  el<HTMLInputElement>('parameter-name').value='';el<HTMLInputElement>('parameter-value').value='';
  levelFacet.setChoices([...(model?.storeys??[]).map(s=>({id:JSON.stringify(s.id),name:s.name})),...((model?.elements??[]).some(e=>e.role==='element'&&!e.storey_id)?[{id:'null',name:'Без уровня'}]:[])]);
  const categories=new Map<string,string>();for(const e of model?.elements??[])if(e.role==='element'){const c=elementCategory(e,model!);categories.set(c.key,c.format+' · '+c.name);}
  categoryFacet.setChoices([...categories].map(([id,name])=>({id,name})));parameterFilters=[];renderParameterFilters();
  const systems=el<HTMLSelectElement>('system-filter');systems.replaceChildren(new Option('Все системы',''),...(model?.systems??[]).map(s=>new Option(`${s.name||s.class} · ${new Set(s.member_ids).size} · #${s.id}`,s.id)));
  viewer?.highlightElements(new Set());renderSystemSummary();
  renderMembers();renderElements();
}
function renderSystemSummary(){
  const id=el<HTMLSelectElement>('system-filter').value,system=model?.systems?.find(s=>s.id===id),host=el('system-summary');
  if(!model||!system){host.textContent=model?`${model.systems?.length??0} систем в прочитанной выгрузке. Отсутствие системы здесь не доказывает её отсутствие в RVT.`:'';return;}
  const coverage=systemCoverage(model,id);
  host.innerHTML=`<strong>${esc(system.name||system.class)}</strong><p>${coverage.declared} участников в выгрузке · ${coverage.geometry} с геометрией · ${coverage.withoutGeometry} без геометрии · ${coverage.missing} не найдены в модели.</p><p>Бирюзовый цвет — участники системы. Подключение и полнота исходного RVT не подтверждены.</p><details><summary>Свойства системы</summary><button data-copy="${esc(JSON.stringify(system,null,2))}">Копировать свойства системы</button><dl><dt>Класс</dt><dd>${copyValue(system.class)}</dd><dt>ID</dt><dd>${copyValue(system.id)}</dd><dt>GlobalId</dt><dd>${copyValue(system.global_id||'Не прочитан')}</dd><dt>Описание</dt><dd>${copyValue(system.description??'Не прочитано')}</dd></dl><pre>${esc(JSON.stringify(system.property_sets??{},null,2))}</pre></details>`;
}
function parameterDraft():ParameterFilter{return {name:el<HTMLInputElement>('parameter-name').value,value:el<HTMLInputElement>('parameter-value').value,operator:el<HTMLSelectElement>('parameter-operator').value as ParameterOperator};}
function renderParameterFilters(){const host=el('parameter-active');host.replaceChildren();parameterFilters.forEach((filter,index)=>{const row=document.createElement('div');row.className='parameter-chip';const text=document.createElement('span');const operator=[...el<HTMLSelectElement>('parameter-operator').options].find(o=>o.value===filter.operator)?.textContent??filter.operator;text.textContent=filter.name+' · '+operator+' '+filter.value;const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label','Убрать условие '+filter.name);remove.onclick=()=>{parameterFilters.splice(index,1);renderParameterFilters();applySceneVisibility();};row.append(text,remove);host.append(row);});}
function renderElements() {
  if(cadFrame)return;
  const query=el<HTMLInputElement>('element-search').value.trim(),levels=levelFacet.selected(),categories=categoryFacet.selected();
  const system=el<HTMLSelectElement>('system-filter').value,members=systemMembers(model,system),filters=[...parameterFilters,parameterDraft()];
  const combine=el<HTMLSelectElement>('parameter-combine').value as 'all'|'any';
  treeItems=(model?.elements??[]).filter(e=>e.role==='element'&&(!system||members.has(e.id))&&(!levels.size||levels.has(JSON.stringify(e.storey_id??null)))&&(!categories.size||categories.has(elementCategory(e,model!).key))&&elementLabelMatches(e,query)&&parametersMatch(e,filters,combine));
  const searching=!!query||filters.some(f=>f.name.trim())||!!levels.size||!!categories.size||!!system;
  tree.render(model,treeItems,selectedId,searching,JSON.stringify([query,filters,combine,[...levels],[...categories],system]),el<HTMLSelectElement>('tree-grouping').value as 'categories'|'levels');
  for(const key of ['hide-matches','show-matches','isolate-matches'])el<HTMLButtonElement>(key).disabled=!treeItems.length;
}
function memberElementIds(instanceId:string){return (model?.elements??[]).filter(e=>e.role==='element'&&(!e.source_instance_id?sceneMembers.length===1:e.source_instance_id===instanceId)).map(e=>e.id);}
function syncMemberVisibility(){for(const member of sceneMembers){const ids=memberElementIds(member.instanceId);member.visible=visibility.count(ids).shown>0;}}
function setElementVisibility(ids:string[],shown:boolean){
  if(shown){renderElements();const matches=new Set(treeItems.map(e=>e.id));if(ids.some(id=>!matches.has(id)))el<HTMLInputElement>('visibility-filter').checked=false;}
  visibility.set(ids,shown);syncMemberVisibility();applySceneVisibility();renderMembers();
  if(selectedId){el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=!visibility.visible(selectedId);}
}
function isolateElements(ids:string[]){
  if(!ids.length||!model)return;
  const matches=new Set(treeItems.map(e=>e.id));if(ids.some(id=>!matches.has(id)))el<HTMLInputElement>('visibility-filter').checked=false;
  visibility.isolate(ids,model.elements.filter(e=>e.role==='element').map(e=>e.id));syncMemberVisibility();applySceneVisibility();renderMembers();viewer?.focusTargets(ids);
  if(selectedId){el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=!visibility.visible(selectedId);}
}
let searchTimer:ReturnType<typeof setTimeout>|undefined;
const searchChanged=()=>{clearTimeout(searchTimer);for(const key of ['hide-matches','show-matches','isolate-matches'])el<HTMLButtonElement>(key).disabled=true;searchTimer=setTimeout(applySceneVisibility,180);};
el('element-search').oninput=searchChanged;el('parameter-name').oninput=searchChanged;el('parameter-value').oninput=searchChanged;
el('parameter-search-details').addEventListener('toggle',()=>{if((el('parameter-search-details') as HTMLDetailsElement).open&&model)el('parameter-names').replaceChildren(...parameterCatalog(model).map(name=>new Option(name,name)));});
el('parameter-operator').onchange=()=>{el<HTMLInputElement>('parameter-value').disabled=['exists','missing'].includes(el<HTMLSelectElement>('parameter-operator').value);applySceneVisibility();};
el('add-parameter').onclick=()=>{const draft=parameterDraft();if(!draft.name.trim())return;parameterFilters.push(draft);el<HTMLInputElement>('parameter-name').value='';el<HTMLInputElement>('parameter-value').value='';renderParameterFilters();applySceneVisibility();};
el('parameter-combine').onchange=applySceneVisibility;
el('clear-parameter').onclick=()=>{parameterFilters=[];renderParameterFilters();el<HTMLInputElement>('parameter-name').value='';el<HTMLInputElement>('parameter-value').value='';applySceneVisibility();};
el('hide-matches').onclick=()=>setElementVisibility(treeItems.map(e=>e.id),false);
el('show-matches').onclick=()=>setElementVisibility(treeItems.map(e=>e.id),true);
el('isolate-matches').onclick=()=>isolateElements(treeItems.map(e=>e.id));
el('hide-selected').onclick=()=>{if(selectedId)setElementVisibility([selectedId],false);};
el('show-selected').onclick=()=>{if(selectedId)setElementVisibility([selectedId],true);};
el('isolate-selected').onclick=()=>{if(selectedId)isolateElements([selectedId]);};
el('tree-grouping').onchange=renderElements;
el('system-filter').onchange=()=>{selectElement(null);renderSystemSummary();applySceneVisibility();};
el('visibility-filter').onchange=applySceneVisibility;
el('reset-visibility').onclick=()=>{visibility.reset();sceneMembers.forEach(m=>m.visible=true);levelFacet.reset();categoryFacet.reset();parameterFilters=[];renderParameterFilters();clipped=false;updateCut();el<HTMLSelectElement>('system-filter').value='';el<HTMLInputElement>('visibility-filter').checked=true;el<HTMLInputElement>('element-search').value='';el<HTMLInputElement>('parameter-name').value='';el<HTMLInputElement>('parameter-value').value='';el<HTMLSelectElement>('parameter-operator').value='contains';el<HTMLInputElement>('parameter-value').disabled=false;renderSystemSummary();applySceneVisibility();renderMembers();if(selectedId){el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=false;}viewer?.fit();};
let cadPending:((reason?:string)=>void)|null=null;
let cadCleanup:(()=>void)|null=null;
function closeCad(){cadPending?.('Загрузка отменена');cadPending=null;cadCleanup?.();cadCleanup=null;cadFrame?.remove();cadFrame=null;el('cad-host').hidden=true;el('canvas').hidden=false;document.body.classList.remove('cad-open');el<HTMLButtonElement>('mode-simulate').disabled=false;el<HTMLButtonElement>('open-model-data').disabled=false;}
async function openCad(file:File) {
  closeCad();selectElement(null);setMode('view');el('canvas').hidden=true;el('cad-host').hidden=false;el('no-model').hidden=true;document.body.classList.add('cad-open');
  el<HTMLButtonElement>('mode-simulate').disabled=true;el('file-title').textContent=file.name;el('geometry-kind').textContent='DWG / DXF · чертёж';
  el<HTMLButtonElement>('open-model-data').disabled=true;
  el('inspector-title').textContent='Чертёж DWG / DXF';el('inspector').textContent='Чтение '+file.name;
  const iframe=document.createElement('iframe');iframe.title='Просмотр DWG / DXF';iframe.src='./cad/';cadFrame=iframe;el('cad-host').append(iframe);renderState();
  await new Promise<void>((resolve,reject)=>{
    const job=crypto.randomUUID();let opened=false,panel:ReturnType<typeof cadTreePanel>|null=null;
    const finish=(reason?:string)=>{clearTimeout(timer);cadPending=null;if(reason){removeEventListener('message',receive);reject(Error(reason));}else{opened=true;resolve();}};
    const receive=(event:MessageEvent)=>{if(event.origin!==location.origin||event.source!==iframe.contentWindow||event.data?.channel!=='uvyazka-cad')return;
      if(event.data.kind==='ready')iframe.contentWindow?.postMessage({channel:'uvyazka-cad',kind:'open',job,file},location.origin);
      if(event.data.job!==job)return;
      if(event.data.kind==='error'){if(opened)error(event.data.message);else finish(event.data.message);}
      if(event.data.kind==='opened'){
        el('inspector').innerHTML=`<dl><dt>Файл</dt><dd>${copyValue(event.data.filename)}</dd><dt>Объектов в модели</dt><dd>${copyValue(event.data.entityCount)}</dd><dt>Слоёв</dt><dd>${copyValue(event.data.layers.length)}</dd></dl>`;el('workspace-status').textContent=`${event.data.entityCount} объектов · ${event.data.layers.length} слоёв · DWG / DXF`;
        el<HTMLDialogElement>('file-dialog').close();panel=cadTreePanel(el('element-tree'),command=>iframe.contentWindow?.postMessage({channel:'uvyazka-cad',job,...command},location.origin));panel.update(event.data.tree as CadTreeState);finish();
      }
      if(event.data.kind==='tree-state')panel?.update(event.data as CadTreeState);
      if(event.data.kind==='entity-selected'){const e=event.data.entity;el('inspector-title').textContent='Объект DWG / DXF';el('inspector').innerHTML=`<button data-copy="${esc(JSON.stringify(e,null,2))}">Копировать свойства</button><dl><dt>Handle / ID</dt><dd>${copyValue(e.id)}</dd><dt>Тип</dt><dd>${copyValue(e.type)}</dd><dt>Слой</dt><dd>${copyValue(e.layer)}</dd></dl>`;setPanel('inspector',true);}
    };
    const timer=setTimeout(()=>finish('Движок DWG не ответил за 120 секунд. Попробуйте меньший файл.'),120000);cadPending=finish;cadCleanup=()=>removeEventListener('message',receive);addEventListener('message',receive);
  });
}

function browserDownload(kind:string,data:RunPackage) {
  let text=JSON.stringify(data,null,2),mime='application/json';
  if(kind==='csv'){
    const cell=(value:unknown)=>{let v=String(value??'');if(/^[=+@-]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
    text='\ufeff'+[['Работа','Начало, мин','Конец, мин','Длительность, мин'],...data.scenario.operations.map(o=>[o.name,data.operation_states[o.id].start,data.operation_states[o.id].finish,o.duration])].map(row=>row.map(cell).join(',')).join('\r\n');mime='text/csv';
  }
  const url=URL.createObjectURL(new Blob([text],{type:mime}));browserUrls.push(url);el<HTMLAnchorElement>(kind).download=kind==='csv'?'uvyazka-schedule.csv':'uvyazka-run.json';return url;
}
const browser=DEMO?browserPanel({
  openDocument:()=>documentPanel?.open(),
  noGeometry:(filename,message)=>{el('file-title').textContent=filename;el('geometry-kind').textContent='RVT · 3D недоступна';el<HTMLButtonElement>('mode-simulate').disabled=true;el<HTMLSelectElement>('models').innerHTML='<option>Геометрия не прочитана</option>';el('inspector-title').textContent='Результат чтения RVT';el('inspector').innerHTML=`<p><strong>${esc(filename)}</strong></p><p>${esc(message)}</p>`;},
  document:(data,message)=>documentPanel?.set(data,message),
  drawing:openCad, cancelDrawing:closeCad,
  reset:(append)=>{++sceneVersion;documentPanel?.set(null);
    if(append&&model&&loadedBinary&&!model.federation&&!sceneMembers.length)sceneMembers=[{instanceId:model.model_id,model,binary:loadedBinary,offset:[0,0,0],rotation:0,visible:true}];
    if(!append){sceneMembers=[];renderMembers();}
    closeCad();setMode('view');el('error').hidden=true;el('element-tree').innerHTML='';++generation;++modelGeneration;project='browser-local';el<HTMLSelectElement>('projects').innerHTML='<option>Локальный файл в браузере</option>';el<HTMLSelectElement>('runs').innerHTML='<option>Сценарий не рассчитан</option>';el<HTMLSelectElement>('models').innerHTML='<option>Чтение модели</option>';el<HTMLSelectElement>('scenes').innerHTML='<option value="">Выберите сцену</option>';document.querySelector('.notice')!.textContent='Свой файл обрабатывается в браузере и не отправляется на сервер. Сценарий предварительный: технология, выработка и связи требуют проверки.';if(!append){browserModel=null;browserBinary=null;}browserRun=null;for(const url of browserUrls)URL.revokeObjectURL(url);browserUrls.length=0;for(const key of ['projects','models','runs'])el<HTMLSelectElement>(key).disabled=true;void loadRun('');if(!append)void loadModel('');else renderModelTree();},
  model:async(pkg,binary,append)=>{
    const candidate:SceneMember={instanceId:pkg.model_id,model:pkg,binary,offset:[0,0,0],rotation:0,visible:true};
    const existing=append?sceneMembers:[];
    if(existing.some(m=>m.model.source.sha256===pkg.source.sha256))throw Error('Этот файл уже есть в сцене. Для повторного размещения нужен отдельный экземпляр.');
    await presentMembers([...existing,candidate]);documentPanel?.geometryReady(!!viewer&&pkg.statistics.meshes>0);el<HTMLDialogElement>('file-dialog').close();return browserModel!;
  },
  run:async(data)=>{setMode('simulate');browserRun=data;for(const url of browserUrls)URL.revokeObjectURL(url);browserUrls.length=0;el<HTMLSelectElement>('runs').innerHTML=`<option value="${esc(data.run_id)}">${esc(data.scenario.name||'Браузерный расчёт')}</option>`;await loadRun(data.run_id);el<HTMLDialogElement>('file-dialog').close();}
}):null;
if(DEMO){el('calculate-current').hidden=false;el('calculate-current').onclick=()=>el<HTMLDialogElement>('file-dialog').showModal();}
type DemoExample={id:string;kind:'model'|'rvt';name:string;url?:string;sha256?:string;size?:number};
const initialExample=new URL(location.href).searchParams.get('example');
async function demoExamples(){
  if(!DEMO||!browser)return;
  const response=await fetch('./demo/examples.json');if(!response.ok)throw Error('Не удалось загрузить каталог примеров');
  const examples=(await response.json()).items as DemoExample[];
  const bar=document.createElement('div');bar.className='demo-toolbar';bar.innerHTML='<label>Пример<select id="demo-example" aria-label="Демонстрационная модель"></select></label><span role="status" id="demo-status">IFC / RVT · данные и 3D на устройстве</span><a href="./demo/ATTRIBUTION.txt" target="_blank" rel="noopener">Источники и лицензии ↗</a>';
  document.querySelector('.app-header')!.after(bar);
  const picker=el<HTMLSelectElement>('demo-example');picker.replaceChildren(...examples.map(e=>new Option(e.name,e.id)));
  async function openExample(id:string){
    const item=examples.find(e=>e.id===id);if(!item)return;picker.value=id;picker.disabled=true;
    el('demo-status').textContent='Открываем '+item.name+'…';
    try{
      browser!.stop('Выбран другой демонстрационный пример.');
      if(item.kind==='rvt'){
        const response=await fetch(new URL(item.url!,location.href));if(!response.ok)throw Error('Не удалось скачать демонстрационный RVT');
        const buffer=await response.arrayBuffer();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(x=>x.toString(16).padStart(2,'0')).join('');
        if(digest!==item.sha256||buffer.byteLength!==item.size)throw Error('Контрольная сумма примера RVT не совпала');
        await browser!.openFile(new File([buffer],'RE1-Mechanical.rvt'),false);
      }else{
        browserModel=null;browserBinary=null;browserRun=null;documentPanel?.set(null);closeCad();
        el<HTMLSelectElement>('projects').innerHTML='<option value="demo-a">Публичные примеры</option>';
        for(const key of ['projects','models','runs'])el<HTMLSelectElement>(key).disabled=false;
        requestedModel=item.id;requestedRun='';await loadProject('demo-a');setMode('view');
        document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:model}));
      }
      const url=new URL(location.href);url.searchParams.set('example',id);history.replaceState(null,'',url);
      el('demo-status').textContent=item.kind==='rvt'?'RVT: результат и покрытие — в журнале обработки.':'Данные доступны в «Данные модели». Расчёт — в «Симуляции».';
    }catch(e){error(e);el('demo-status').textContent=String(e);}finally{picker.disabled=false;}
  }
  picker.onchange=()=>void openExample(picker.value);
  if(initialExample&&examples.some(e=>e.id===initialExample))await openExample(initialExample);
  else {if(!model&&examples[0]?.kind==='model')await loadModel(examples[0].id);picker.value=model?.model_id||examples[0]?.id||'';document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:model}));}
}
void (async()=>{try{const r=await fetch(DEMO?'./demo/projects.json':'/api/projects');const d=await r.json();if(project==='browser-local')return;el<HTMLSelectElement>('projects').innerHTML=d.projects.map((p:{id:string;name:string})=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');project=project||d.default_project;if(project){el<HTMLSelectElement>('projects').value=project;await loadProject(project,DEMO&&!!initialExample);await demoExamples();}else error('Сначала зарегистрируйте проект или запустите uvyazka demo.');}catch(e){error(e);}})();

function setPanel(panel:'tree'|'inspector',open:boolean) {
  if(open&&matchMedia('(max-width: 650px)').matches){
    const other=panel==='tree'?'inspector':'tree';
    document.body.classList.add(other+'-closed');
    el('toggle-'+other).setAttribute('aria-expanded','false');
  }
  document.body.classList.toggle(panel+'-closed',!open);
  el('toggle-'+panel).setAttribute('aria-expanded',String(open));
}
el('toggle-tree').onclick=()=>setPanel('tree',document.body.classList.contains('tree-closed'));
el('toggle-inspector').onclick=()=>setPanel('inspector',document.body.classList.contains('inspector-closed'));
el('close-tree').onclick=()=>{setPanel('tree',false);el('toggle-tree').focus();};
el('close-inspector').onclick=()=>{setPanel('inspector',false);el('toggle-inspector').focus();};
el('file-settings').onclick=()=>el<HTMLDialogElement>('file-dialog').showModal();
el('close-file').onclick=()=>el<HTMLDialogElement>('file-dialog').close();
function chooseModel(append:boolean){if(!DEMO){el<HTMLDialogElement>('file-dialog').showModal();return;}el<HTMLInputElement>('browser-append').checked=append;el<HTMLInputElement>('browser-file').click();}
el('open-file').onclick=()=>chooseModel(true);
el('empty-add-model').onclick=()=>chooseModel(true);
el('replace-model').onclick=()=>chooseModel(false);
el('help').onclick=()=>el<HTMLDialogElement>('help-dialog').showModal();
el('close-help').onclick=()=>el<HTMLDialogElement>('help-dialog').close();
el('toggle-schedule').onclick=()=>{
  const opened=document.body.classList.toggle('schedule-open');
  el('toggle-schedule').setAttribute('aria-expanded',String(opened));
};
function jumpToOperation(event:MouseEvent){
  const id=(event.target as HTMLElement).closest<HTMLElement>('[data-operation]')?.dataset.operation;
  if(id&&clock&&run&&Number.isFinite(run.operation_states[id]?.start)&&run.operation_states[id].start!==null){touring=false;el('tour').setAttribute('aria-pressed','false');clock.playing=false;clock.seek(run.operation_states[id].start);renderState();const op=run.scenario.operations.find(o=>o.id===id);if(op)viewer?.focusTargets(op.target_ids);}
};
el('schedule').onclick=jumpToOperation;el('gantt-body').onclick=jumpToOperation;
if(matchMedia('(max-width: 650px)').matches)setPanel('tree',false);
if(matchMedia('(max-width: 950px)').matches)setPanel('inspector',false);
el('status-details').onclick=()=>el<HTMLDialogElement>('file-dialog').showModal();

function renderGantt(){
  const unit=el<HTMLSelectElement>('time-unit').value as TimelineUnit;
  const label={days:'Сутки от начала',hours:'Часы от начала',minutes:'Минуты от начала'}[unit];
  if(!run){el('gantt-ruler').innerHTML='';el('gantt-body').innerHTML='<p class="gantt-empty">Выберите рассчитанный сценарий в параметрах.</p>';el('schedule-summary').textContent='Нет выбранного расчёта';return;}
  el('gantt-ruler').innerHTML=`<span class="gantt-title">${label}</span><div class="gantt-axis">${[0,.25,.5,.75,1].map(r=>`<span style="left:${r*100}%">${timeLabel(run!.duration*r,unit)}</span>`).join('')}</div>`;
  const rows=timelineRows(run);
  el('gantt-body').innerHTML=rows.map(row=>`<div class="gantt-row"><span class="gantt-name" title="${esc(row.name)}">${esc(row.name)}</span><div class="gantt-track">${row.bars.map(bar=>bar.left===null?`<span class="gantt-unscheduled" title="${esc(bar.name)}">Без расчётного срока</span>`:`<button class="gantt-bar" data-operation="${esc(bar.id)}" style="left:${bar.left}%;width:${bar.width}%" aria-label="${esc(bar.name)}: ${timeLabel(bar.start!,unit)} — ${timeLabel(bar.finish!,unit)}" title="${esc(bar.name)} · ${bar.start} → ${bar.finish} мин · ${bar.evidence==='assumed'?'Допущение':'С источником'}"></button>`).join('')}</div></div>`).join('');
  el('schedule-summary').textContent=`${run.scenario.operations.length} работ · ${rows.length} групп · расчётное время без календаря`;
}
el('time-unit').onchange=()=>{renderGantt();renderState();};
el('timeline-zoom').onchange=()=>{el('gantt').style.width=Number(el<HTMLSelectElement>('timeline-zoom').value)*100+'%';};
el('schedule-details-toggle').onclick=()=>{const open=el('schedule-details').hidden;el('schedule-details').hidden=!open;el('schedule-details-toggle').setAttribute('aria-expanded',String(open));};
