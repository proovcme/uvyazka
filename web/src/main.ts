import './style.css';
import { workScenes } from './scenes';
const DEMO = import.meta.env.VITE_UVYAZKA_DEMO === '1';
import { Viewer } from './viewer';
import type { ModelPackage } from './model';
import { PlaybackClock, projectState } from './simulation';
import type { RunPackage } from './simulation';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let project = new URL(location.href).searchParams.get('project') || '';
let requestedModel = new URL(location.href).searchParams.get('model') || '';
let requestedRun = new URL(location.href).searchParams.get('run') || '';
let viewer: Viewer | null = null, model: ModelPackage | null = null, run: RunPackage | null = null, clock: PlaybackClock | null = null, frame = 0, last = 0, generation = 0, modelGeneration = 0;
document.getElementById('app')!.innerHTML = `
<header><a class="brand" id="memory-link" href="/">У<span>Увязка<small>Графики и моделирование</small></span></a><label>Проект<select id="projects" aria-label="Проект"></select></label><a id="back" href="/">База проекта ↗</a></header>
<main><section class="intro"><span class="eyebrow">КОНСТРУКТИВНАЯ МОДЕЛЬ И ГРАФ РАБОТ</span><h1>От исходных данных к сценарию строительства</h1><p>Сценарий можно подготовить с агентом или автоматически при загрузке RVT. Здесь — модель, расчётный график и основания работ.</p></section>
<div class="notice">Расчёт сценария не утверждает инженерные решения. Время непрерывное, без смен и погоды; геометрия по документам может быть условной.</div>
<div class="error" id="error" role="alert" hidden></div>
<section class="controls"><label>Рассчитанный сценарий<select id="runs" aria-label="Рассчитанный сценарий"></select></label><label>Пространственная модель<select id="models" aria-label="Пространственная модель"></select></label><a id="csv" hidden>Выгрузить график CSV ↗</a><a id="journal" hidden>Журнал JSON ↗</a></section>
<div class="metrics" id="metrics"></div>
<div class="workspace"><section class="scene panel"><div class="panel-head"><h2>Модель и ход работ</h2><span id="geometry-kind"></span></div><div id="canvas"></div><div id="no-model">Модель пока не задана. График можно рассчитывать без геометрии.</div><div class="scene-tools"><label><input id="site" type="checkbox" checked>Площадка</label><label>Сцена<select id="scenes" aria-label="Сцена работ"><option value="">Выберите сцену</option></select></label><button id="cut">Разрез</button><button id="tour" aria-pressed="false">Автопоказ</button><button id="iso">Общий вид</button><button id="top">Сверху</button><button id="fit">Вписать</button><label><input id="show-complete" type="checkbox" checked>Вся модель</label></div><div class="playback"><button id="play" aria-label="Воспроизвести" disabled>▶</button><button id="rewind" aria-label="В начало" disabled>↶</button><input id="time" type="range" min="0" max="1" value="0" aria-label="Виртуальное время" disabled><span id="clock">0 мин</span><label>Скорость<select id="rate" aria-label="Скорость"><option value="10">10×</option><option value="60" selected>60×</option><option value="240">240×</option></select></label></div></section>
<aside class="panel"><div class="panel-head"><h2 id="inspector-title">Состояние сценария</h2></div><div class="inspector" id="inspector"><p>Выберите сохранённый расчёт или загрузите RVT в локальной панели для автоматической подготовки сценария.</p></div><div class="inspector" id="resources"></div></aside></div>
<section class="panel"><div class="panel-head"><h2>Расчётный график</h2><span>Зелёная отметка — критическая работа по связям, без ресурсных ограничений</span></div><div class="schedule-wrap"><table><thead><tr><th>Работа</th><th>Начало / конец, мин</th><th>Ход работ</th><th>Основание</th></tr></thead><tbody id="schedule"></tbody></table></div></section>
<section class="panel notes"><h2>Допущения и покрытие</h2><div id="assumptions">Нет выбранного расчёта.</div><p>Каждый запуск связан с сохранённой ревизией модели и сценария. Расчёт не является фактом строительства.</p></section></main>`;

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
  viewer?.select(id); const e = model?.elements.find(e => e.id === id);
  if (!e) { renderState(); return; }
  el('inspector-title').textContent = e.name;
  el('inspector').innerHTML = `<span class="eyebrow">${esc(e.class)}</span><dl><dt>ID</dt><dd>${esc(e.id)}</dd><dt>GlobalId</dt><dd>${esc(e.global_id || 'Не задан')}</dd><dt>Материалы</dt><dd>${esc(e.materials.join(', ') || 'Не заданы')}</dd></dl><h3>Происхождение</h3><pre>${esc(JSON.stringify(e.source,null,2))}</pre><details><summary>Свойства и количества</summary><pre>${esc(JSON.stringify({properties:e.property_sets,quantities:e.quantity_sets},null,2))}</pre></details>`;
}
try { viewer = new Viewer(el('canvas'), selectElement); } catch(e) { error('3D недоступно; график и расчёты остаются доступны. ' + String(e)); }
el('canvas').addEventListener('viewer-error', ((e: CustomEvent<string>) => error(e.detail)) as EventListener);
async function loadModel(id: string) {
  const token = ++modelGeneration; viewer?.setSite(null);
  if (!id) { model = null; el('no-model').hidden = false; el('geometry-kind').textContent = 'Без геометрии'; viewer?.show(new Set<string>()); return; }
  const [pkg, binary] = await Promise.all([api<ModelPackage>('model?model_id=' + encodeURIComponent(id)), fetch(path('geometry.bin?model_id=' + encodeURIComponent(id))).then(async r => {if(!r.ok) throw Error('Не удалось загрузить геометрию');return r.arrayBuffer();})]);
  if (token !== modelGeneration) return;
  model = pkg; viewer?.load(pkg,binary); viewer?.setSourceColors(Boolean(pkg.federation)); viewer?.show(new Set(pkg.elements.filter(e => e.role === 'element').map(e=>e.id))); el('no-model').hidden = true;
  el('geometry-kind').textContent = pkg.source.schema === 'SyntheticDemo' ? 'Синтетическая сводная модель · АР + ОВ' : pkg.source.schema === 'DocumentSpatialModel' ? 'Условная геометрия по документам' : 'Геометрия IFC'; renderState();
}
async function loadRun(id: string) {
  const token = ++generation; touring=false;el('tour').setAttribute('aria-pressed','false'); if (clock) clock.playing = false;
  run = null; clock = null;
  for (const key of ['metrics','schedule','resources']) el(key).innerHTML = '';
  for (const key of ['csv','journal']) { el(key).hidden = true; el(key).removeAttribute('href'); }
  for (const key of ['play','rewind','time']) (el(key) as HTMLButtonElement).disabled = true;
  el('clock').textContent = '0 мин'; el<HTMLInputElement>('time').value = '0';
  el('assumptions').textContent = 'Нет выбранного расчёта.';
  if (!id) { renderState(); return; }
  const data = await api<RunPackage & {cpm: {duration_minutes:number; operations:Record<string,{critical:boolean}>}}>('run?run_id=' + encodeURIComponent(id));
  if (token !== generation) return;
  run = data; clock = new PlaybackClock(run.duration); clock.rate = Number(el<HTMLSelectElement>('rate').value);
  el<HTMLInputElement>('time').max = String(run.duration); el<HTMLInputElement>('time').disabled = false; el<HTMLButtonElement>('play').disabled = false; el<HTMLButtonElement>('rewind').disabled = false;
  el('metrics').innerHTML = [[run.scenario.operations.length,'Работ'],[run.duration,'Расчётных минут'],[data.cpm.duration_minutes,'Минут по одним связям'],[run.events.filter(e=>e.kind==='resource_wait').length,'Ожиданий ресурсов']].map(([n,s])=>`<article><strong>${n}</strong><span>${s}</span></article>`).join('');
  for (const [key,route] of [['csv','schedule.csv'],['journal','run']]) { el<HTMLAnchorElement>(key).href = path(route+'?run_id='+encodeURIComponent(run.run_id)); el(key).hidden = false; }
  el('assumptions').innerHTML = run.scenario.assumptions.map(s=>`<p>${esc(s)}</p>`).join('') + `<p>Элементов вне графа работ: ${run.scenario.unplanned_element_ids.length}. Статус расчёта: ${esc(run.status)}.</p>`;
  el('schedule').innerHTML = run.scenario.operations.map(o=> {const s=run!.operation_states[o.id]; const critical=data.cpm.operations[o.id].critical; return `<tr data-operation="${esc(o.id)}"><td><strong>${critical?'<span class="critical" title="Критическая по связям">●</span> ':''}${esc(o.name)}</strong><small>${esc(o.id)} · ${esc(o.dependencies.join(', ') || 'Начальная работа')}</small></td><td>${s.start ?? '—'} → ${s.finish ?? '—'}</td><td><div class="track"><i style="left:${(s.start||0)/Math.max(1,run!.duration)*100}%;width:${o.duration/Math.max(1,run!.duration)*100}%"></i></div></td><td><span>${esc(o.evidence.kind === 'assumed' ? 'Допущение' : 'С источником')}</span><small>${esc(o.evidence.reason)}</small></td></tr>`;}).join('');
  const modelId = run.scenario.model_id || ''; el<HTMLSelectElement>('models').value = modelId; await loadModel(modelId); el<HTMLSelectElement>('scenes').innerHTML='<option value="">Выберите сцену</option>'+ (model?workScenes(run,model):[]).map((s,i)=>`<option value="${i}">${esc(s.title)}</option>`).join(''); renderState();
}
function renderState() {
  el('inspector-title').textContent = 'Состояние сценария';
  if (!run || !clock) {el('inspector').innerHTML='<p>Нет выбранного расчёта. Подготовьте сценарий при загрузке RVT в локальной панели или с помощью агента.</p>'; return;}
  const tick = Math.floor(clock.time), state = projectState(run,tick);
  viewer?.setConstruction(state.construction, el<HTMLInputElement>('show-complete').checked);
  if(model?.model_id===run.scenario.model_id) viewer?.setSite(el<HTMLInputElement>('site').checked?run:null,tick);
  el('clock').textContent = tick+' мин'; el<HTMLInputElement>('time').value = String(tick);
  el('play').textContent=clock.playing?'Ⅱ':'▶'; el('play').setAttribute('aria-label',clock.playing?'Пауза':'Воспроизвести');
  el('inspector').innerHTML=`<p><strong>${state.completed} / ${run.scenario.operations.length}</strong> работ завершено</p><h3>В работе</h3>${state.active.map(o=>`<p>${esc(o.name)}</p>`).join('')||'<p>Нет активных работ</p>'}<h3>Ожидают ресурсы</h3>${state.waiting.map(o=>`<p>${esc(o.name)}</p>`).join('')||'<p>Нет ожидающих работ</p>'}`;
  el('resources').innerHTML='<h3>Ресурсы</h3>'+run.scenario.resources.map(r=>`<label>${esc(r.name)}<strong>${state.resources.get(r.id)||0} / ${r.capacity}</strong><progress value="${state.resources.get(r.id)||0}" max="${r.capacity}"></progress></label>`).join('');
  document.querySelectorAll<HTMLElement>('[data-operation]').forEach(row=>row.dataset.state=state.states.get(row.dataset.operation!)||'pending');
}
async function loadProject(id:string) {
  ++generation; ++modelGeneration; touring=false;el('tour').setAttribute('aria-pressed','false'); if(clock) clock.playing=false; project=id; el('error').hidden=true;
  el<HTMLAnchorElement>('back').href=DEMO?'/':'/?project='+encodeURIComponent(id); if(DEMO)el('back').textContent='locia.work ↗'; if(!DEMO)el<HTMLAnchorElement>('memory-link').href=el<HTMLAnchorElement>('back').href;
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
function showScene(index:number) {if(!run||!model||!clock)return; const scenes=workScenes(run,model); const s=scenes[index];if(!s)return;el<HTMLSelectElement>('scenes').value=String(index);clock.seek(s.start);renderState();viewer?.cutaway(s.cut??null);if(s.targetIds.length)viewer?.focusTargets(s.targetIds);else viewer?.fit();if(s.reference){viewer?.setConstruction(null);viewer?.setSite(null);}}
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
el('show-complete').addEventListener('change',renderState);
el('iso').addEventListener('click',()=>viewer?.fit('iso'));el('top').addEventListener('click',()=>viewer?.fit('top'));el('fit').addEventListener('click',()=>viewer?.fit());
document.addEventListener('visibilitychange',()=>{last=0;});
el('site').addEventListener('change',()=>{renderState();viewer?.fit();});
el('scenes').addEventListener('change',()=>{if(!run||!model||!clock)return;const i=el<HTMLSelectElement>('scenes').value;if(i==='')return;const s=workScenes(run,model)[Number(i)];touring=false;el('tour').setAttribute('aria-pressed','false');clock.playing=false;clock.seek((s.start+s.end)/2);renderState();viewer?.cutaway(s.cut??null);if(s.targetIds.length)viewer?.focusTargets(s.targetIds);else viewer?.fit();if(s.reference){viewer?.setConstruction(null);viewer?.setSite(null);}});
let clipped=false;
el('cut').addEventListener('click',()=>{clipped=!clipped;const bounds=viewer?.modelHeight();viewer?.cutaway(clipped&&bounds?(bounds.min+bounds.max)/2:null);el('cut').setAttribute('aria-pressed',String(clipped));});
if(DEMO){document.body.classList.add('public-demo');document.querySelector('h1')!.textContent='График строительства в 3D';el('memory-link').innerHTML='У<span>Увязка<small>Публичное демо · IFCCS 0.5</small></span>';el<HTMLAnchorElement>('memory-link').href='https://github.com/proovcme/uvyazka';document.querySelector('.notice')!.textContent='Синтетическая учебная модель. Сроки и технологии предварительные. «Автопоказ» проведёт по сценам и сократит ожидания при просмотре. Загрузки файлов и обращения к ИИ здесь нет.';}
void (async()=>{try{const r=await fetch(DEMO?'./demo/projects.json':'/api/projects');const d=await r.json();el<HTMLSelectElement>('projects').innerHTML=d.projects.map((p:{id:string;name:string})=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');project=project||d.default_project;if(project){el<HTMLSelectElement>('projects').value=project;await loadProject(project);}else error('Сначала зарегистрируйте проект или запустите uvyazka demo.');}catch(e){error(e);}})();
