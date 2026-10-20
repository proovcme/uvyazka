import { workspaceShell, icon } from './workspace-shell';
import {timelineRows,timeLabel} from './timeline';
import type {TimelineUnit} from './timeline';
import './style.css';
import { browserPanel } from './browser-panel';
import type { BrowserRun } from './browser-panel';
import { workScenes } from './scenes';
const DEMO = import.meta.env.VITE_UVYAZKA_DEMO === '1';
import { Viewer } from './viewer';
import type { ModelPackage } from './model';
import { PlaybackClock, projectState } from './simulation';
import type { RunPackage } from './simulation';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let browserModel:ModelPackage|null=null, browserBinary:ArrayBuffer|null=null, browserRun:BrowserRun|null=null;
const browserUrls:string[]=[];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let selectedId:string|null=null;
let workspaceMode: "view"|"simulate" = "view", cadFrame:HTMLIFrameElement|null=null;
let project = new URL(location.href).searchParams.get('project') || '';
let requestedModel = new URL(location.href).searchParams.get('model') || '';
let requestedRun = new URL(location.href).searchParams.get('run') || '';
let viewer: Viewer | null = null, model: ModelPackage | null = null, run: RunPackage | null = null, clock: PlaybackClock | null = null, frame = 0, last = 0, generation = 0, modelGeneration = 0;
document.getElementById('app')!.innerHTML = workspaceShell;

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
  viewer?.select(id);document.querySelectorAll<HTMLElement>('.element-item').forEach(row=>row.setAttribute('aria-pressed',String(row.dataset.id===id)));if(id)setPanel('inspector',true); const e = model?.elements.find(e => e.id === id);
  if (!e) { renderState(); return; }
  el('inspector-title').textContent = e.name;
  const renderSets=(sets:Record<string,Record<string,unknown>>)=>Object.entries(sets).map(([name,values])=>`<details class="property-set" open><summary>${esc(name)}</summary><dl>${Object.entries(values).map(([key,value])=>`<dt>${esc(key)}</dt><dd>${esc(value===null?'Не задано':typeof value==='object'?JSON.stringify(value):value)}</dd>`).join('')}</dl></details>`).join('');
  el('inspector').innerHTML = `<span class="eyebrow">${esc(e.class)}</span><dl><dt>ID</dt><dd>${esc(e.id)}</dd><dt>Этаж</dt><dd>${esc(model?.storeys.find(s=>s.id===e.storey_id)?.name||'Не задан')}</dd><dt>Материалы</dt><dd>${esc(e.materials.join(', ') || 'Не заданы')}</dd></dl>${renderSets(e.quantity_sets)}${renderSets(e.property_sets)}<details><summary>Идентификаторы и источник</summary><dl><dt>GlobalId</dt><dd>${esc(e.global_id||'Не задан')}</dd></dl><pre>${esc(JSON.stringify(e.source,null,2))}</pre></details>`;
}
try { viewer = new Viewer(el('canvas'), selectElement); } catch(e) { error('3D недоступно; график и расчёты остаются доступны. ' + String(e)); }
el('canvas').addEventListener('viewer-error', ((e: CustomEvent<string>) => error(e.detail)) as EventListener);
async function loadModel(id: string) {
  const token = ++modelGeneration; selectedId=null;viewer?.select(null); viewer?.setSite(null);clipped=false;el('cut-controls').hidden=true;el('cut').setAttribute('aria-pressed','false');el('xray').setAttribute('aria-pressed','false');
  if (!id) { model = null;el('file-title').textContent='Модель не выбрана'; el('no-model').hidden = false; el('geometry-kind').textContent = 'Без геометрии'; viewer?.show(new Set<string>());renderModelTree();renderState();return; }
  const [pkg, binary] = browserModel?.model_id===id&&browserBinary ? [browserModel,browserBinary] : await Promise.all([api<ModelPackage>('model?model_id=' + encodeURIComponent(id)), fetch(path('geometry.bin?model_id=' + encodeURIComponent(id))).then(async r => {if(!r.ok) throw Error('Не удалось загрузить геометрию');return r.arrayBuffer();})]);
  if (token !== modelGeneration) return;
  model = pkg; el("workspace-status").textContent=`${pkg.statistics.physical_elements} элементов · ${pkg.storeys.length} этажей${pkg.source.schema==='SyntheticDemo'?' · Учебная модель':''}`; el("file-title").textContent=pkg.source.filename; renderModelTree(); viewer?.load(pkg,binary); viewer?.setSourceColors(false); viewer?.show(new Set(pkg.elements.filter(e => e.role === 'element').map(e=>e.id))); el('no-model').hidden = true;
  el('geometry-kind').textContent = pkg.source.schema === 'SyntheticDemo' ? 'Синтетическая сводная модель · АР + ОВ' : pkg.source.schema === 'DocumentSpatialModel' ? 'Условная геометрия по документам' : pkg.source.format==='rvt' ? 'RVT → IFC · экспериментальная геометрия' : 'Геометрия IFC'; renderState();
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
    el('inspector').innerHTML=cadFrame?'<p>DWG / DXF: просмотр чертежа, масштабирование и слои.</p><p>Для строительной симуляции нужна модель с элементами и объёмами. Чертёж сам по себе их не подтверждает.</p>':model?`<p><strong>${esc(model.source.filename)}</strong></p><dl><dt>Элементов / с геометрией</dt><dd>${model.elements.length} / ${model.statistics.meshes}</dd><dt>Этажей</dt><dd>${model.storeys.length}</dd><dt>Источник</dt><dd>${esc(model.source.schema)}</dd></dl><p>Выберите элемент на модели или в структуре, чтобы увидеть свойства и количества.</p>`:'<p>Откройте DWG, DXF, RVT или IFC.</p>';
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
async function loadProject(id:string) {
  ++generation; ++modelGeneration; touring=false;el('tour').setAttribute('aria-pressed','false'); if(clock) clock.playing=false; project=id; el('error').hidden=true;
  el<HTMLAnchorElement>('back').href=DEMO?'/':'/?project='+encodeURIComponent(id); if(DEMO)el('back').textContent='locia.work ↗'; if(!DEMO)el<HTMLAnchorElement>('memory-link').href=el<HTMLAnchorElement>('back').href;
  el('measurement-link').hidden=DEMO;
  if(!DEMO)el<HTMLAnchorElement>('measurement-link').href='/measurements/?project='+encodeURIComponent(id);
  history.replaceState(null,'','?project='+encodeURIComponent(id));
  const key=project; const [models,runs]=await Promise.all([api<{items:{model_id:string;name:string}[]}>('models'),api<{items:{run_id:string;scenario_id:string;scenario_revision:number;duration_minutes:number;name?:string}[]}>('runs')]); if(key!==project)return;
  el<HTMLSelectElement>('models').innerHTML='<option value="">Без геометрии</option>'+models.items.map(m=>`<option value="${esc(m.model_id)}">${esc(m.name)}</option>`).join('');
  el<HTMLSelectElement>('runs').innerHTML='<option value="">Выберите расчёт</option>'+runs.items.map(r=>`<option value="${esc(r.run_id)}">${esc(r.name||r.scenario_id)} · ревизия ${r.scenario_revision} · ${r.duration_minutes} мин</option>`).join('');
  const requested=runs.items.find(r=>r.run_id===requestedRun);
  if(requested){el<HTMLSelectElement>('runs').value=requested.run_id;await loadRun(requested.run_id);}
  else if(models.items.some(m=>m.model_id===requestedModel)){el<HTMLSelectElement>('models').value=requestedModel;await loadRun('');await loadModel(requestedModel);}
  else if(runs.items.length){el<HTMLSelectElement>('runs').value=runs.items.at(-1)!.run_id; await loadRun(runs.items.at(-1)!.run_id);} else {await loadRun(''); await loadModel(models.items[0]?.model_id||'');el<HTMLSelectElement>('models').value=models.items[0]?.model_id||'';}
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
  clipped=height!==null;
  const bounds=viewer?.modelHeight();
  if(height!==null&&bounds)el<HTMLInputElement>('cut-position').value=String(Math.max(0,Math.min(100,(height-bounds.min)/Math.max(.001,bounds.max-bounds.min)*100)));
  updateCut();
}
function updateCut(){
  const bounds=viewer?.modelHeight();const height=bounds?bounds.min+(bounds.max-bounds.min)*Number(el<HTMLInputElement>('cut-position').value)/100:0;
  viewer?.cutaway(clipped?height:null);el('cut-controls').hidden=!clipped;el('cut').setAttribute('aria-pressed',String(clipped));el('cut-height').textContent=(height+(model?.coordinate_system.render_origin_m[2]||0)).toFixed(2)+' м';
}
el('cut').addEventListener('click',()=>{clipped=!clipped;updateCut();});
el('cut-position').addEventListener('input',updateCut);
el('xray').onclick=()=>{const active=el('xray').getAttribute('aria-pressed')!=='true';el('xray').setAttribute('aria-pressed',String(active));viewer?.setXray(active,model?.elements??[]);};
document.body.classList.add('viewer-app','schedule-open');document.body.dataset.mode='view';
if(DEMO){const downloads=document.createElement('a');downloads.href='./downloads/';downloads.textContent='Исходники';el('back').before(downloads);el('back').hidden=true;document.body.classList.add('public-demo');el<HTMLAnchorElement>('memory-link').href='https://github.com/proovcme/uvyazka';document.querySelector('.notice')!.textContent='Учебная модель. Откройте свой файл для просмотра или перейдите в «Симуляцию», чтобы изучить сценарий строительства.';}
function setMode(mode:'view'|'simulate') {
  if(mode==='simulate'&&cadFrame){error('DWG открыт как чертёж. Для симуляции загрузите IFC или RVT с геометрией и рассчитайте сценарий.');return;}
  workspaceMode=mode;document.body.dataset.mode=mode;
  el('mode-view').setAttribute('aria-pressed',String(mode==='view'));el('mode-simulate').setAttribute('aria-pressed',String(mode==='simulate'));
  if(clock)clock.playing=false;touring=false;last=0;cancelAnimationFrame(frame);el('tour').setAttribute('aria-pressed','false');
  setPanel('tree',!matchMedia('(max-width: 650px)').matches);setPanel('inspector',!matchMedia('(max-width: 950px)').matches);
  if(mode==='simulate')viewer?.show(new Set(model?.elements.filter(e=>e.role==='element').map(e=>e.id)??[]));
  renderState();if(mode==='view'){viewer?.show(new Set(model?.elements.filter(e=>e.role==='element').map(e=>e.id)??[]));viewer?.fit();}
}
el('mode-view').onclick=()=>setMode('view');el('mode-simulate').onclick=()=>setMode('simulate');
function renderModelTree() {
  const storey=el<HTMLSelectElement>('storey-filter');storey.replaceChildren(new Option('Все этажи',''),...(model?.storeys??[]).map(s=>new Option(s.name,s.id)));
  renderElements();
}
function renderElements() {
  const query=el<HTMLInputElement>('element-search').value.toLowerCase(),floor=el<HTMLSelectElement>('storey-filter').value;
  const items=(model?.elements??[]).filter(e=>e.role==='element'&&(!floor||e.storey_id===floor)&&(`${e.name} ${e.class} ${e.id}`).toLowerCase().includes(query));
  const groups=new Map<string,Map<string,typeof items>>();
  for(const item of items.slice(0,1000)){
    const floor=item.storey_id||'';if(!groups.has(floor))groups.set(floor,new Map());
    const classes=groups.get(floor)!;if(!classes.has(item.class))classes.set(item.class,[]);classes.get(item.class)!.push(item);
  }
  el('element-tree').innerHTML=`<p>${items.length} элементов${items.length>1000?' · первые 1000; уточните поиск':''}</p>`+[...groups].map(([floor,classes])=>`<details class="tree-storey" open><summary>${esc(model?.storeys.find(s=>s.id===floor)?.name||'Без этажа')}<small>${[...classes.values()].flat().length}</small></summary>${[...classes].map(([type,elements])=>`<details class="tree-class" ${query||elements.some(e=>e.id===selectedId)||items.length<60?'open':''}><summary>${esc(type)} · ${elements.length}</summary>${elements.map(e=>`<button class="element-item" aria-pressed="${e.id===selectedId}" data-id="${esc(e.id)}">${icon('cube')}<span><strong>${esc(e.name||e.id)}</strong><small>${esc(e.class)}</small></span></button>`).join('')}</details>`).join('')}</details>`).join('');
}
el('element-search').oninput=renderElements;el('storey-filter').onchange=()=>{renderElements();if(workspaceMode==='view'){const floor=el<HTMLSelectElement>('storey-filter').value;const ids=(model?.elements??[]).filter(e=>e.role==='element'&&(!floor||e.storey_id===floor)).map(e=>e.id);viewer?.show(new Set(ids));viewer?.focusTargets(ids);}};
el('reset-visibility').onclick=()=>{el<HTMLSelectElement>('storey-filter').value='';el<HTMLInputElement>('element-search').value='';renderElements();viewer?.show(new Set(model?.elements.filter(e=>e.role==='element').map(e=>e.id)??[]));viewer?.fit();};
el('element-tree').onclick=event=>{const id=(event.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;if(id){selectElement(id);viewer?.focusTargets([id]);}};
let cadPending:((reason?:string)=>void)|null=null;
function closeCad(){cadPending?.('Загрузка отменена');cadPending=null;cadFrame?.remove();cadFrame=null;el('cad-host').hidden=true;el('canvas').hidden=false;document.body.classList.remove('cad-open');el<HTMLButtonElement>('mode-simulate').disabled=false;}
async function openCad(file:File) {
  closeCad();selectElement(null);setMode('view');el('canvas').hidden=true;el('cad-host').hidden=false;el('no-model').hidden=true;document.body.classList.add('cad-open');
  el<HTMLButtonElement>('mode-simulate').disabled=true;el('file-title').textContent=file.name;el('geometry-kind').textContent='DWG / DXF · чертёж';
  const iframe=document.createElement('iframe');iframe.title='Просмотр DWG / DXF';iframe.src='./cad/';cadFrame=iframe;el('cad-host').append(iframe);renderState();
  await new Promise<void>((resolve,reject)=>{
    const job=crypto.randomUUID();const finish=(reason?:string)=>{clearTimeout(timer);removeEventListener('message',receive);cadPending=null;reason?reject(Error(reason)):resolve();};
    const receive=(event:MessageEvent)=>{if(event.origin!==location.origin||event.source!==iframe.contentWindow||event.data?.channel!=='uvyazka-cad')return;
      if(event.data.kind==='ready')iframe.contentWindow?.postMessage({channel:'uvyazka-cad',kind:'open',job,file},location.origin);
      if(event.data.job!==job)return;
      if(event.data.kind==='error')finish(event.data.message);
      if(event.data.kind==='opened'){el<HTMLDialogElement>('file-dialog').close();el('element-tree').textContent=`Слои: ${event.data.layers.length}. Прочитано объектов модели: ${event.data.entityCount}. ${event.data.entityCount?"Переключайте слои над чертежом.":"Геометрия модели не получена; возможен неподдерживаемый состав DWG."}`;finish();}
    };
    const timer=setTimeout(()=>finish('Движок DWG не ответил за 120 секунд. Попробуйте меньший файл.'),120000);cadPending=finish;addEventListener('message',receive);
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
if(DEMO)browserPanel({
  drawing:openCad, cancelDrawing:closeCad,
  reset:()=>{closeCad();setMode('view');el('error').hidden=true;el('element-tree').innerHTML='';++generation;++modelGeneration;project='browser-local';el<HTMLSelectElement>('projects').innerHTML='<option>Локальный файл в браузере</option>';el<HTMLSelectElement>('runs').innerHTML='<option>Сценарий не рассчитан</option>';el<HTMLSelectElement>('models').innerHTML='<option>Чтение модели</option>';el<HTMLSelectElement>('scenes').innerHTML='<option value="">Выберите сцену</option>';document.querySelector('.notice')!.textContent='Свой файл обрабатывается в браузере и не отправляется на сервер. Сценарий предварительный: технология, выработка и связи требуют проверки.';browserModel=null;browserBinary=null;browserRun=null;for(const url of browserUrls)URL.revokeObjectURL(url);browserUrls.length=0;for(const key of ['projects','models','runs'])el<HTMLSelectElement>(key).disabled=true;void loadRun('');void loadModel('');},
  model:async(pkg,binary)=>{browserModel=pkg;browserBinary=binary;el<HTMLSelectElement>('models').innerHTML=`<option value="${esc(pkg.model_id)}">${esc(pkg.source.filename)}</option>`;await loadModel(pkg.model_id);el<HTMLDialogElement>('file-dialog').close();},
  run:async(data)=>{setMode('simulate');browserRun=data;for(const url of browserUrls)URL.revokeObjectURL(url);browserUrls.length=0;el<HTMLSelectElement>('runs').innerHTML=`<option value="${esc(data.run_id)}">${esc(data.scenario.name||'Браузерный расчёт')}</option>`;await loadRun(data.run_id);el<HTMLDialogElement>('file-dialog').close();}
});
void (async()=>{try{const r=await fetch(DEMO?'./demo/projects.json':'/api/projects');const d=await r.json();if(project==='browser-local')return;el<HTMLSelectElement>('projects').innerHTML=d.projects.map((p:{id:string;name:string})=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');project=project||d.default_project;if(project){el<HTMLSelectElement>('projects').value=project;await loadProject(project);}else error('Сначала зарегистрируйте проект или запустите uvyazka demo.');}catch(e){error(e);}})();

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
el('open-file').onclick=()=>{if(DEMO)el<HTMLInputElement>('browser-file').click();else el<HTMLDialogElement>('file-dialog').showModal();};
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
