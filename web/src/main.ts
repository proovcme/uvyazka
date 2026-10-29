import {sameReadSource,rvtMode} from './browser-rvt-direct';
import {geometryQuality} from './geometry-quality';
import {isNavisFormat,onlyNavisSources} from './navis-format.ts';
import {installWindowControls} from './window-controls';
import './window-controls.css';
import {specificationPanel} from './specification-panel';
import {reviewPanel} from './review-panel';
import {engineeringPanel} from './engineering-panel';
import {workspacePanel} from './workspace-panel';
import {measurementKey} from './spatial-measurements';
import type {ViewerState,SavedScene} from './viewer-workspace';
import {initTheme} from './theme';
import {prepareScene} from './federation-client';
import {validatePackage} from './model';
import {levelSummary,renderCoverage} from './model-coverage';
import {autoRecovery,listRecovery,readRecovery} from './workspace-autosave';
import {ReviewRepository} from './review-client';
import {SourceAlreadyPresent} from './import-errors';
import {validateViewerState} from './viewer-state-validation';
import {sceneStore} from './viewer-workspace';
import {inspectRevision} from './source-revision-client';
import {remapRevisionState} from './source-revision';
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
import type {RvtDocument,NativeRecord} from './rvt-document';
import {loadProjectCatalog,saveProjectCatalog,projectCatalogs,loadCatalogSnapshot,loadModelCatalog} from './rvt-catalog-client';
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
const selection=new Set<string>();let networkHighlights=new Set<string>();const visibilityHistory:{hidden:string[];apply3d:boolean;filters?:ViewerState['filters']}[]=[];
let workspaceMode: "view"|"simulate" = "view", cadFrame:HTMLIFrameElement|null=null;
let project = new URL(location.href).searchParams.get('project') || '';
let measurementProject=project||'browser-local';
let sceneMembers:SceneMember[]=[],loadedBinary:ArrayBuffer|null=null;
let sceneVersion=0,sceneCompositionOpen=false,scenePreparation:AbortController|null=null,revisionPreparation:AbortController|null=null;
let sourceChanges:unknown[]=[];
let requestedModel = new URL(location.href).searchParams.get('model') || '';
let requestedRun = new URL(location.href).searchParams.get('run') || '';
let viewer: Viewer | null = null, model: ModelPackage | null = null, run: RunPackage | null = null, clock: PlaybackClock | null = null, frame = 0, last = 0, generation = 0, modelGeneration = 0;
const visibility=new ModelVisibility();let visibilityModelId='',treeItems:BimElement[]=[],sceneFilterItems:BimElement[]=[],hiddenOnly=false;
let parameterFilters:ParameterFilter[]=[];
const catalogues=new Map<string,RvtDocument>();let catalogueProject=project;
document.getElementById('app')!.innerHTML = workspaceShell;
const tree=modelTreePanel(el('element-tree'),visibility,{select:(id,additive)=>{selectElement(id,additive);if(!additive)viewer?.focusTargets([id]);},show:setElementVisibility,isolate:isolateElements,document:openDocumentRecord});
const levelFacet=facetFilter(el<HTMLDetailsElement>('level-filter'),'Уровни',applySceneVisibility);
const categoryFacet=facetFilter(el<HTMLDetailsElement>('category-filter'),'Категории',applySceneVisibility);
initTheme();
installWindowControls();
installPropertyCopy();
modelDataPanel(()=>model,id=>{selectElement(id);viewer?.focusTargets([id]);});
const specifications=specificationPanel({shared:!DEMO,model:()=>model,documents:()=>[...catalogues.values()],project:()=>measurementProject,matches:()=>treeItems.map(e=>e.id),selection:()=>[...selection],show:showSpecificationElements});
reviewPanel({shared:!DEMO,project:()=>measurementProject,capture:captureWorkspace,apply:applyWorkspaceState,selection:()=>[...selection],matches:()=>treeItems.map(e=>e.id),
 focus:ids=>{isolateElements(ids);const state=captureWorkspace().state;state.selection=ids;state.view.planes=[];state.view.xray=false;applyWorkspaceState(state);viewer?.focusTargets(ids);},
 projection:()=>({aspect:viewer?.camera.aspect??1,vertical_fov:viewer?.camera.fov??40}),snapshot:()=>{if(!viewer)throw Error('Модель не открыта');viewer.renderer.render(viewer.scene,viewer.camera);return viewer.renderer.domElement.toDataURL('image/png').split(',')[1];}});
const documentPanel=rvtDocumentPanel(record=>{
  const orientation=viewOrientation(record);if(!orientation||!viewer||!model)return;
  setMode('view');el('reset-visibility').click();viewer.orient(orientation.direction,orientation.up);
  el('workspace-status').textContent='Ориентация вида · реконструкция без оформления, обрезки и фильтров Revit';
},()=>{setMode('view');el('reset-visibility').click();},{model:()=>model,showElements:showSpecificationElements,...(DEMO?{}:{context:()=>project,listCatalogs:offset=>projectCatalogs(project,offset),loadCatalog:async id=>{const target=project;const data=await loadCatalogSnapshot(target,id);if(target===project){acceptDocument(data);documentPanel.geometryReady(!!model&&!model.federation&&model.source.sha256===data.source?.sha256);}},importCatalog:async data=>{const target=project;const restored=await saveProjectCatalog(target,data);if(target!==project)return;acceptDocument(restored);}})});

function showSpecificationElements(ids:string[]){
 const available=new Set((model?.elements??[]).filter(e=>e.mesh).map(e=>e.id));const targets=[...new Set(ids)].filter(id=>available.has(id));
 if(!targets.length)return;
 setMode('view');setElementVisibility(targets,true);selectElement(targets[0]);selection.clear();for(const id of targets)selection.add(id);updateSelection();viewer?.focusTargets(targets);
 el('workspace-status').textContent=`Показано элементов из таблицы: ${targets.length}`;
}

function acceptDocument(data:RvtDocument|null){if(data?.source?.sha256)catalogues.set(data.source.sha256,data);documentPanel.set(data);documentPanel.geometryReady(!!viewer&&!!model&&!model.federation&&model.source.sha256===data?.source?.sha256&&model.statistics.meshes>0);renderElements();}
function openDocumentRecord(data:RvtDocument,record:NativeRecord){const ready=!!viewer&&!!model&&!model.federation&&model.source.sha256===data.source?.sha256;documentPanel.openRecord(data,record,ready);}
async function restoreCatalogues(pkg:ModelPackage,token:number){
 if(DEMO)return;const target=project;
 const sources=pkg.federation?.members??[{model_id:pkg.model_id,source_sha256:pkg.source.sha256,source_format:pkg.source.format,instance_id:''}];
 const results=await Promise.allSettled(sources.map(async member=>{if(member.source_sha256)return {member,data:await loadProjectCatalog(target,member.source_sha256)};const resolved=await loadModelCatalog(target,member.model_id);return {member:{...member,source_sha256:resolved.source.sha256,source_format:resolved.source.format},data:resolved.document};}));
 if(token!==modelGeneration||target!==project)return;
 const resolved=new Map<string,{source_sha256?:string;source_format?:string}>();
 for(const result of results)if(result.status==='fulfilled'){const {data,member}=result.value;resolved.set(member.instance_id,member);if(data?.source?.sha256){catalogues.set(data.source.sha256,data);documentPanel.set(data);}}else error('Каталог базы проекта недоступен: '+String(result.reason));
 if(pkg.federation)model={...pkg,federation:{...pkg.federation,members:pkg.federation.members.map(m=>({...m,...resolved.get(m.instance_id)}))}};
 renderElements();documentPanel.geometryReady(!!viewer&&!pkg.federation&&catalogues.has(pkg.source.sha256));
}


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
function selectElement(id: string | null,additive=false) {
  if(!additive)selection.clear();if(id){if(additive&&selection.has(id))selection.delete(id);else selection.add(id);}updateSelection();
  if(additive&&id&&!selection.has(id))id=[...selection].at(-1)??null;selectedId=id;engineering.open(id);el('resources').innerHTML='';
  el('selected-visibility-actions').hidden=!id;
  if(id){tree.reveal(id);el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=[...selection].every(id=>!visibility.visible(id));}
  viewer?.select(id);document.querySelectorAll<HTMLElement>('.element-item').forEach(row=>row.setAttribute('aria-pressed',String(selection.has(row.dataset.id??''))));if(id)setPanel('inspector',true); const e = model?.elements.find(e => e.id === id);
  el('selected-visibility-actions').hidden=!selection.size||!e||e.role!=='element';
  if (!e) { renderState(); return; }
  el('inspector-title').textContent = e.name;
  const identity=elementIdentity(e),systems=elementSystems(model,e.id),quality=geometryQuality(e);
  const renderSets=(sets:Record<string,Record<string,unknown>>)=>Object.entries(sets).map(([name,values])=>`<details class="property-set" ${e.nwd&&name==='NWD fragment'||name==='Источник RVT'?'':'open'}><summary>${esc(e.nwd&&name==='NWD fragment'?'Служебные данные чтения Navisworks':name)}</summary><dl>${Object.entries(values).map(([key,value])=>`<dt>${esc(key)}</dt><dd>${copyValue(value)}</dd>`).join('')}</dl></details>`).join('');
  const card={...e,revit_identity:identity,systems,model_source:model?.source};
  el('inspector').innerHTML = `<span class="eyebrow">${esc(e.class)}</span><button class="copy-card" data-copy="${esc(JSON.stringify(card,null,2))}">Копировать все свойства</button><dl><dt>Revit ElementId</dt><dd>${identity.element_id?copyValue(identity.element_id):'Не прочитан'}</dd><dt>Revit UniqueId</dt><dd>${identity.unique_id?copyValue(identity.unique_id):'Не прочитан'}</dd><dt>IFC / ID сцены</dt><dd>${copyValue(e.id)}</dd><dt>Этаж</dt><dd>${copyValue(model?.storeys.find(s=>s.id===e.storey_id)?.name||'Не прочитан')}</dd><dt>Материалы</dt><dd>${copyValue(e.materials.join(', ')||'Не прочитаны')}</dd></dl><p class="identity-basis">${esc(identity.basis)}</p>${renderSets(e.quantity_sets)}${renderSets(e.property_sets)}<details><summary>Идентификаторы и источник</summary><dl><dt>IFC GlobalId</dt><dd>${e.global_id?copyValue(e.global_id):'Не прочитан'}</dd><dt>Исходный Tag</dt><dd>${e.tag?copyValue(e.tag):'Не прочитан'}</dd></dl><pre>${esc(JSON.stringify(e.source,null,2))}</pre></details>`;
  if(quality){const note=document.createElement('p');note.className='geometry-quality';note.dataset.quality=quality.kind;note.textContent=quality.message;el('inspector').querySelector('.copy-card')!.after(note);}
  el('inspector').innerHTML+=`<details ${systems.length?'open':''}><summary>${systems.length?'Прочитанных систем: '+systems.length:'Системы не прочитаны'}</summary>${systems.map(s=>`<p>${esc(s.name||s.class)} · #${esc(s.id)}</p>`).join('')||'<p>Принадлежность к системе не прочитана.</p>'}<p>Членство не подтверждает физическое подключение.</p></details>`;
}
try { viewer = new Viewer(el('canvas'), selectElement); } catch(e) { error('3D недоступно; график и расчёты остаются доступны. ' + String(e)); }
const spatial=spatialPanel(viewer,()=>model,()=>measurementProject,error,()=>[...selection],()=>loadedBinary);
const engineering=engineeringPanel(el('engineering-panel'),()=>model,{select:id=>selectElement(id),highlight:ids=>{networkHighlights=new Set(ids);if(ids.length){const known=new Set(model?.elements.map(e=>e.id));setElementVisibility(ids.filter(id=>known.has(id)),true);}else refreshHighlights();},isolate:isolateElements});
function inspectorTab(network:boolean){el('engineering-panel').hidden=!network;el('property-content').hidden=network;el('network-tab').setAttribute('aria-pressed',String(network));el('properties-tab').setAttribute('aria-pressed',String(!network));setPanel('inspector',true);}
el('network-tab').onclick=()=>inspectorTab(true);el('properties-tab').onclick=()=>inspectorTab(false);el('open-network').onclick=()=>{engineering.open(selectedId);inspectorTab(true);};
function refreshHighlights(){viewer?.highlightElements(new Set([...selection,...networkHighlights,...systemMembers(model,el<HTMLSelectElement>('system-filter').value)]));}
function updateSelection(){el('selection-count').textContent='Выбрано '+selection.size;refreshHighlights();document.querySelectorAll<HTMLElement>('.element-item').forEach(row=>row.setAttribute('aria-pressed',String(selection.has(row.dataset.id??''))));}
function rememberVisibility(){visibilityHistory.push({hidden:visibility.snapshot(),apply3d:el<HTMLInputElement>('visibility-filter').checked,filters:model&&loadedBinary?captureWorkspace().state.filters:undefined});if(visibilityHistory.length>30)visibilityHistory.shift();el<HTMLButtonElement>('undo-visibility').disabled=false;}
el('undo-visibility').onclick=()=>{const previous=visibilityHistory.pop();if(!previous)return;visibility.restore(previous.hidden);if(previous.filters)restoreFilters(previous.filters);el<HTMLInputElement>('visibility-filter').checked=previous.apply3d;syncMemberVisibility();applySceneVisibility();renderMembers();el<HTMLButtonElement>('undo-visibility').disabled=!visibilityHistory.length;};
const savedWorkspace=workspacePanel({project:()=>measurementProject,capture:captureWorkspace,restore:restoreWorkspace,apply:applyWorkspaceState,matches:()=>treeItems.map(e=>e.id),selection:()=>[...selection],show:isolateElements,highlight:ids=>{networkHighlights=new Set(ids);refreshHighlights();},error,shared:!DEMO});
const saveStatus=document.createElement('button');saveStatus.className='workspace-save-status';saveStatus.textContent='Работа в браузере';saveStatus.onclick=()=>el('open-workspace').click();document.querySelector('.status-bar')!.append(saveStatus);
const recovery=autoRecovery({project:()=>measurementProject,capture:captureWorkspace,status:(text,dirty)=>{saveStatus.textContent=dirty?'Не сохранено':'Сохранено';saveStatus.title=text;saveStatus.dataset.dirty=String(dirty);}});
let initialLoad:Promise<void>=Promise.resolve();
const recoveryBanner=document.createElement('section');recoveryBanner.className='recovery-banner';recoveryBanner.hidden=true;document.querySelector('.app-header')!.after(recoveryBanner);
void listRecovery(measurementProject).then(rows=>{const row=rows[0];if(!row)return;const text=document.createElement('span');text.textContent='Сохранилась работа: '+row.filename;const resume=document.createElement('button');resume.textContent='Восстановить последнюю работу';resume.onclick=async()=>{resume.disabled=true;try{await initialLoad;const target=measurementProject,scene=await readRecovery(target,row.id);if(!scene||target!==measurementProject)throw Error('Автосохранение выбранного проекта недоступно');await restoreWorkspace(scene);recoveryBanner.hidden=true;}catch(reason){error(reason);}finally{resume.disabled=false;}};const close=document.createElement('button');close.textContent='Позже';close.onclick=()=>recoveryBanner.hidden=true;recoveryBanner.replaceChildren(text,resume,close);recoveryBanner.hidden=false;}).catch(()=>{});
for(const name of ['input','change','click','pointerup','keyup','wheel'])document.addEventListener(name,event=>{const target=event.target as HTMLElement;if(target?.closest?.('#conversion-dialog,.import-journal'))return;recovery.dirty();},{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void recovery.flush();});
window.addEventListener('beforeunload',event=>{if(recovery.hasPending()){event.preventDefault();event.returnValue=true;}});window.addEventListener('pagehide',()=>recovery.dispose());
el('workspace-settings').onclick=()=>{el<HTMLDialogElement>('file-dialog').close();el('open-workspace').click();};
function captureWorkspace():Omit<SavedScene,'id'|'name'|'created_at'|'project_id'>{
 if(cadFrame)throw Error('Сейчас открыт DWG / DXF. Сохранённые виды и проверки сеток доступны для RVT / IFC / NWD.');
 if(!model||!viewer||!loadedBinary)throw Error('Сначала откройте модель');
 const measurements=JSON.parse(localStorage.getItem(measurementKey(measurementProject))??'[]');
 const state:ViewerState={version:1,model_id:model.model_id,source_sha256:model.source.sha256,hidden:visibility.snapshot(),selection:[...selection],filters:{query:el<HTMLInputElement>('element-search').value,levels:[...levelFacet.selected()],categories:[...categoryFacet.selected()],system:el<HTMLSelectElement>('system-filter').value,parameters:[...parameterFilters,parameterDraft()].filter(f=>f.name.trim()),combine:el<HTMLSelectElement>('parameter-combine').value as 'all'|'any',apply3d:el<HTMLInputElement>('visibility-filter').checked,grouping:el<HTMLSelectElement>('tree-grouping').value as 'categories'|'levels'},view:viewer.captureView(),measurements,sets:savedWorkspace.sets(),specifications:specifications.definitions()};
 return {state,model,binary:loadedBinary,members:sceneMembers,documents:[...catalogues.values()],source_changes:sourceChanges};
}
function applyWorkspaceState(state:ViewerState){
 if(model)validateViewerState(state,model);
 if(state.version!==1||!model||state.model_id!==model.model_id||state.source_sha256!==model.source.sha256)throw Error('Рабочее место относится к другому пакету модели. Сначала откройте соответствующий снимок / модель.');
 const ids=new Set(model.elements.map(e=>e.id));if([...state.hidden,...state.selection].some(id=>!ids.has(id)))throw Error('В рабочем месте есть элементы, не найденные в этой модели');
 viewer?.restoreView(state.view);visibility.restore(state.hidden);selection.clear();for(const id of state.selection)selection.add(id);
 restoreFilters(state.filters);syncMemberVisibility();applySceneVisibility();renderMembers();renderSystemSummary();updateSelection();localStorage.setItem(measurementKey(measurementProject),JSON.stringify(state.measurements));savedWorkspace.putSets(state.sets);specifications.restore(state.specifications??[]);
 const restoredSelection=[...selection];selectElement(restoredSelection.at(-1)??null);selection.clear();for(const id of restoredSelection)selection.add(id);updateSelection();el('selected-visibility-actions').hidden=!selection.size;
 clipped=state.view.planes.length>0;el('cut').setAttribute('aria-pressed',String(clipped));el('cut-controls').hidden=true;el('xray').setAttribute('aria-pressed',String(state.view.xray));
}
function restoreFilters(f:ViewerState['filters']){el<HTMLInputElement>('element-search').value=f.query;levelFacet.restore(f.levels);categoryFacet.restore(f.categories);el<HTMLSelectElement>('system-filter').value=f.system;parameterFilters=f.parameters;el<HTMLInputElement>('parameter-name').value='';el<HTMLInputElement>('parameter-value').value='';el<HTMLSelectElement>('parameter-combine').value=f.combine;el<HTMLInputElement>('visibility-filter').checked=f.apply3d;el<HTMLSelectElement>('tree-grouping').value=f.grouping;renderParameterFilters();}
async function restoreWorkspace(scene:SavedScene){
 validateViewerState(scene.state,scene.model);
 if(scene.project_id!==measurementProject)throw Error('Снимок принадлежит другому проекту');browser?.stop('Открыто сохранённое рабочее место.');
 const members=scene.members.length?scene.members:[{instanceId:scene.model.model_id,model:scene.model,binary:scene.binary,offset:[0,0,0] as [number,number,number],rotation:0,visible:true}];
 await presentMembers(members,()=>commitBrowserContext(false),scene);sourceChanges=scene.source_changes??[];for(const document of scene.documents??[])if(document.source?.sha256)acceptDocument(document);applyWorkspaceState(scene.state);recovery.dirty();
 if(!DEMO){const target=project,repo=new ReviewRepository(true,()=>target);for(const item of [...members,{model:scene.model,binary:scene.binary}])await repo.registerModel(item.model,item.binary,text=>saveStatus.title=text,()=>target!==project);for(const document of scene.documents??[])await saveProjectCatalog(target,document);}
}

el('canvas').addEventListener('viewer-error', ((e: CustomEvent<string>) => error(e.detail)) as EventListener);
async function loadModel(id: string) {
  if(catalogueProject!==project){catalogues.clear();documentPanel.set(null);catalogueProject=project;}
  const token = ++modelGeneration; hiddenOnly=false;spatial.reset();selection.clear();networkHighlights.clear();visibilityHistory.length=0;el<HTMLButtonElement>('undo-visibility').disabled=true;selectedId=null;el('selected-visibility-actions').hidden=true;viewer?.select(null); viewer?.setSite(null);clipped=false;el('cut-controls').hidden=true;el('cut').setAttribute('aria-pressed','false');el('xray').setAttribute('aria-pressed','false');
  if (!id) { model = null;engineering.reset();updateSelection();loadedBinary=null;visibility.reset();visibilityModelId='';el('file-title').textContent='Модель не выбрана'; el('no-model').hidden = false; el('geometry-kind').textContent = 'Без геометрии'; viewer?.show(new Set<string>());renderModelTree();renderState();if(!DEMO){const target=project;void projectCatalogs(target).then(async page=>{const row=page.items.find(r=>['all','views','schedules','catalog'].includes(r.profile));if(!row)return;const data=await loadCatalogSnapshot(target,row.extraction_id);if(target===project&&token===modelGeneration&&!model)acceptDocument(data);}).catch(e=>error('Каталог базы недоступен: '+String(e)));}return; }
  const [pkg, binary] = browserModel?.model_id===id&&browserBinary ? [browserModel,browserBinary] : await Promise.all([api<ModelPackage>('model?model_id=' + encodeURIComponent(id)), fetch(path('geometry.bin?model_id=' + encodeURIComponent(id))).then(async r => {if(!r.ok) throw Error('Не удалось загрузить геометрию');return r.arrayBuffer();})]);
  if (token !== modelGeneration) return;
  model = pkg;engineering.reset();updateSelection();loadedBinary=binary;if(visibilityModelId!==pkg.model_id){visibility.reset();visibilityModelId=pkg.model_id;visibility.set(pkg.elements.filter(e=>!sceneVisible(e.source_instance_id)).map(e=>e.id),false);} el("workspace-status").textContent=`${pkg.rvt_direct?pkg.statistics.products+' владельцев графики RVT':onlyNavisSources(pkg)?(pkg.nwd?.logical_nodes??0)+' узлов · '+(pkg.nwd?.fragments??0)+' фрагментов '+(isNavisFormat(pkg.source.format)?pkg.source.format!.toUpperCase():'Navisworks'):pkg.statistics.physical_elements+' элементов'} · ${pkg.storeys.length?pkg.storeys.length+' уровней':'Уровни не прочитаны'}${pkg.source.schema==='SyntheticDemo'?' · Учебная модель':''}`; el("file-title").textContent=pkg.source.filename; renderModelTree(); viewer?.load(pkg,binary); viewer?.setSourceColors(pkg.source.schema!=='SyntheticDemo'); document.dispatchEvent(new Event('model-data-changed')); applySceneVisibility(); el('no-model').hidden = true;void restoreCatalogues(pkg,token);
  el('geometry-kind').textContent = pkg.source.schema === 'SyntheticDemo' ? 'Синтетическая сводная модель · АР + ОВ' : pkg.source.schema === 'DocumentSpatialModel' ? 'Условная геометрия по документам' : pkg.federation ? 'Сводная геометрия · совмещение требует проверки' : pkg.source.rvt_read_mode==='direct' ? 'RVT напрямую · экспериментальная сохранённая графика' : pkg.source.format==='rvt' ? 'RVT → IFC · экспериментальная геометрия' : isNavisFormat(pkg.source.format)?pkg.source.format!.toUpperCase()+' · дерево, свойства и геометрия · '+(pkg.source.calibrations?.every(c=>c.source_units_decoded)?'единицы из файла':'единицы с допущениями'):'Геометрия IFC'; renderState();
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
    el('inspector').innerHTML=cadFrame?'<p>DWG / DXF: просмотр чертежа, масштабирование и слои.</p><p>Для строительной симуляции нужна модель с элементами и объёмами. Чертёж сам по себе их не подтверждает.</p>':model?`<p><strong>${esc(model.source.filename)}</strong></p><dl><dt>${model.rvt_direct?'Владельцев графики / с геометрией':onlyNavisSources(model)?'Фрагментов / с геометрией':'Физических элементов / с геометрией'}</dt><dd>${model.rvt_direct?model.statistics.products:onlyNavisSources(model)?(model.nwd?.fragments??0):model.statistics.physical_elements} / ${model.statistics.meshes}</dd><dt>Уровней</dt><dd>${levelSummary(model)}</dd><dt>Источник</dt><dd>${esc(model.source.rvt_read_mode==='direct'?'RVT напрямую · эксперимент':model.source.format==='rvt'?'RVT → '+model.source.schema:model.source.schema)}</dd></dl><p>Выберите элемент на модели или в структуре, чтобы увидеть свойства и количества.</p>`:'<p>Откройте DWG, DXF, RVT, IFC, NWD или NWC.</p>';
    if(model){const coverage=document.createElement('details');const title=document.createElement('summary');title.textContent='Что удалось прочитать';coverage.append(title);const body=document.createElement('div');coverage.append(body);renderCoverage(body,model);el('inspector').append(coverage);}
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
  renderElements();const filtered=el<HTMLInputElement>('visibility-filter').checked?new Set(sceneFilterItems.map(e=>e.id)):null;
  viewer?.show(new Set((model?.elements??[]).filter(e=>e.role==='element'&&visibility.visible(e.id)&&(!filtered||filtered.has(e.id))).map(e=>e.id)));
  refreshHighlights();
}
async function presentMembers(members:SceneMember[],commitContext?:()=>void,expected?:SavedScene){
  scenePreparation?.abort();const controller=new AbortController();scenePreparation=controller;
  const version=++sceneVersion;
  if(!members.length){sceneMembers=[];browserModel=null;browserBinary=null;browserRun=null;await loadRun('');await loadModel('');renderMembers();document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:null}));return;}
  // A single untransformed member keeps its original IDs for existing schedules.
  const only=members[0],single=members.length===1&&only.offset.every(n=>n===0)&&only.rotation===0;
  let result:{model:ModelPackage;binary:ArrayBuffer};
  try{result=single?{model:only.model,binary:only.binary}:await prepareScene(members,{signal:controller.signal,progress:text=>browser?.sceneProgress(text)});validatePackage(result.model,result.binary);}finally{if(scenePreparation===controller)scenePreparation=null;}
  if(version!==sceneVersion||controller.signal.aborted)throw Error('Подготовка сцены отменена.');
  if(expected){
    if(result.model.model_id!==expected.model.model_id||result.model.source.sha256!==expected.model.source.sha256)throw Error('Состав проекта не соответствует сохранённой сцене. Текущая сцена сохранена.');
    const hash=async(value:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].join(',');if(await hash(result.binary)!==await hash(expected.binary))throw Error('Геометрия проекта не соответствует его составу. Текущая сцена сохранена.');validateViewerState(expected.state,result.model);
  }
  const previous=model&&loadedBinary&&viewer&&!cadFrame?captureWorkspace():null,oldProject=project,oldCatalogues=new Map(catalogues);
  try{
    commitContext?.();sceneMembers=members;browserModel=result.model;browserBinary=result.binary;browserRun=null;
    await loadRun('');el<HTMLSelectElement>('runs').innerHTML='<option>Сценарий не рассчитан</option>';
    el<HTMLSelectElement>('models').replaceChildren(new Option(result.model.source.filename,result.model.model_id));
    await loadModel(result.model.model_id);viewer?.setSourceColors(members.length>1);applySceneVisibility();recoveryBanner.hidden=true;recovery.dirty();
  }catch(error){
    if(previous){project=oldProject;catalogueProject=oldProject;catalogues.clear();for(const [key,value]of oldCatalogues)catalogues.set(key,value);sourceChanges=previous.source_changes??[];sceneMembers=previous.members;browserModel=previous.model;browserBinary=previous.binary;await loadModel(previous.model.model_id);applyWorkspaceState(previous.state);}
    throw error;
  }
}
function renderMembers(){
  const host=el('scene-members');host.replaceChildren();
  const add=document.createElement('button');add.textContent='+ Добавить модель';add.className='add-scene-model';add.onclick=()=>{el<HTMLInputElement>('browser-append').checked=true;el<HTMLInputElement>('browser-file').click();};host.append(add);
  const direct=document.createElement('button');direct.textContent='RVT напрямую · эксперимент';direct.className='add-scene-folder';direct.onclick=()=>{el<HTMLInputElement>('browser-append').checked=false;el<HTMLInputElement>('browser-rvt-file').click();};host.append(direct);
  const folder=document.createElement('button');folder.textContent='Папка моделей';folder.className='add-scene-folder';folder.onclick=()=>{el<HTMLInputElement>('browser-append').checked=true;el<HTMLInputElement>('browser-folder').click();};host.append(folder);
  if(!sceneMembers.length)return;
  const composition=document.createElement('details');composition.className='scene-composition';composition.open=sceneCompositionOpen;const heading=document.createElement('summary');heading.textContent='Состав сцены · '+sceneMembers.length;composition.append(heading);composition.ontoggle=()=>{if(composition.isConnected)sceneCompositionOpen=composition.open;};host.append(composition);
  const note=document.createElement('p');note.textContent=sceneMembers.length>1?'Общие координаты · совмещение не подтверждено':'Исходные координаты модели';composition.append(note);
  for(const member of sceneMembers){
    const row=document.createElement('details');row.className='scene-member';
    const summary=document.createElement('summary');summary.textContent=member.model.source.filename+(member.model.source.format==='rvt'?(rvtMode(member.model)==='direct'?' · напрямую':' · через IFC'):'');row.append(summary);
    const visible=document.createElement('input');visible.type='checkbox';const ids=memberElementIds(member.instanceId);const state=visibility.count(ids);visible.checked=state.checked;visible.indeterminate=state.mixed;
    const label=document.createElement('label');label.className='check';label.append(visible,document.createTextNode('Показывать модель'));row.append(label);
    visible.onchange=()=>{member.visible=visible.checked;setElementVisibility(ids,visible.checked);};
    const coords=document.createElement('div');coords.className='placement-fields';const inputs:HTMLInputElement[]=[];
    for(const [i,name] of ['X, м','Y, м','Z, м','Угол Z, °'].entries()){const field=document.createElement('label');field.textContent=name;const input=document.createElement('input');input.type='number';input.step='any';input.value=String(i<3?member.offset[i]:member.rotation);input.setAttribute('aria-label',name+' · '+member.model.source.filename);inputs.push(input);field.append(input);coords.append(field);}row.append(coords);
    const apply=document.createElement('button');apply.textContent='Применить размещение';apply.onclick=()=>{const values=inputs.map(i=>i.value.trim()===''?NaN:Number(i.value));if(!values.every(Number.isFinite)){error('Заполните X, Y, Z и угол конечными числами');return;}void presentMembers(sceneMembers.map(m=>m===member?{...m,offset:[values[0],values[1],values[2]],rotation:values[3]}:m)).then(()=>document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:browserModel}))).catch(error);};row.append(apply);
    const remove=document.createElement('button');remove.textContent='Убрать из сцены';remove.onclick=()=>{void presentMembers(sceneMembers.filter(m=>m!==member)).then(()=>document.dispatchEvent(new CustomEvent('scene-model-changed',{detail:browserModel}))).catch(error);};row.append(remove);
    const update=document.createElement('button');update.textContent='Обновить источник';update.onclick=()=>{const input=document.createElement('input');input.type='file';input.accept='.rvt,.ifc,.nwd,.nwc';input.hidden=true;document.body.append(input);input.addEventListener('cancel',()=>input.remove());input.onchange=()=>{const file=input.files?.[0];input.remove();if(file)void browser.openFile(file,true,{replaceInstanceId:member.instanceId,rvtMode:rvtMode(member.model)});};input.click();};row.append(update);
    const metadata=document.createElement('small');metadata.textContent=`${onlyNavisSources(member.model)?(member.model.nwd?.fragments??0)+' геометрических фрагментов':member.model.rvt_direct?member.model.statistics.products+' владельцев графики RVT':member.model.statistics.physical_elements+' элементов'} · SHA-256 ${member.model.source.sha256.slice(0,12)}…`;row.append(metadata);composition.append(row);
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
  sceneFilterItems=(model?.elements??[]).filter(e=>(e.role==='element'||e.semantic_kind==='source_node')&&(!system||members.has(e.id))&&(!levels.size||levels.has(JSON.stringify(e.storey_id??null)))&&(!categories.size||categories.has(elementCategory(e,model!).key))&&elementLabelMatches(e,query)&&parametersMatch(e,filters,combine));
  const hiddenItems=(model?.elements??[]).filter(e=>e.role==='element'&&!visibility.visible(e.id));
  treeItems=hiddenOnly?hiddenItems:sceneFilterItems;
  el('hidden-count').textContent=`Скрыто: ${hiddenItems.length}`;
  el<HTMLButtonElement>('browse-hidden').disabled=!model||!hiddenItems.length&&!hiddenOnly;
  el('browse-hidden').setAttribute('aria-pressed',String(hiddenOnly));
  el('browse-hidden').textContent=hiddenOnly?'К дереву':'Список';
  el<HTMLButtonElement>('restore-hidden').disabled=!hiddenItems.length;
  el('hidden-list-note').hidden=!hiddenOnly;
  const searching=!!query||filters.some(f=>f.name.trim())||!!levels.size||!!categories.size||!!system;
  document.querySelector<HTMLElement>('.tree-match-actions')!.hidden=!searching||hiddenOnly;
  tree.render(model,treeItems,selectedId,searching||hiddenOnly,JSON.stringify([query,filters,combine,[...levels],[...categories],system,hiddenOnly]),el<HTMLSelectElement>('tree-grouping').value as 'categories'|'levels',hiddenOnly?[]:[...catalogues.values()],query);
  if(hiddenOnly&&!hiddenItems.length){const empty=el('element-tree').lastElementChild;if(empty?.tagName==='P')empty.textContent='Скрытых элементов нет. Вернитесь к дереву модели.';}
  for(const key of ['hide-matches','show-matches','isolate-matches'])el<HTMLButtonElement>(key).disabled=!treeItems.length;updateSelection();
}
function memberElementIds(instanceId:string){return (model?.elements??[]).filter(e=>e.role==='element'&&(!e.source_instance_id?sceneMembers.length===1:e.source_instance_id===instanceId)).map(e=>e.id);}
function syncMemberVisibility(){for(const member of sceneMembers){const ids=memberElementIds(member.instanceId);member.visible=visibility.count(ids).shown>0;}}
function setElementVisibility(ids:string[],shown:boolean){
  rememberVisibility();
  if(shown){renderElements();const matches=new Set(sceneFilterItems.map(e=>e.id));if(ids.some(id=>!matches.has(id)))el<HTMLInputElement>('visibility-filter').checked=false;}
  visibility.set(ids,shown);syncMemberVisibility();applySceneVisibility();renderMembers();
  if(selectedId){el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=[...selection].every(id=>!visibility.visible(id));}
}
function isolateElements(ids:string[]){
  if(!ids.length||!model)return;
  rememberVisibility();
  const matches=new Set(sceneFilterItems.map(e=>e.id));if(ids.some(id=>!matches.has(id)))el<HTMLInputElement>('visibility-filter').checked=false;
  visibility.isolate(ids,model.elements.filter(e=>e.role==='element').map(e=>e.id));syncMemberVisibility();applySceneVisibility();renderMembers();viewer?.focusTargets(ids);
  if(selectedId){el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=[...selection].every(id=>!visibility.visible(id));}
}
el('browse-hidden').onclick=()=>{hiddenOnly=!hiddenOnly;renderElements();};
el('restore-hidden').onclick=()=>{const ids=(model?.elements??[]).filter(e=>e.role==='element'&&!visibility.visible(e.id)).map(e=>e.id);hiddenOnly=false;if(ids.length)setElementVisibility(ids,true);else renderElements();};
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
el('hide-selected').onclick=()=>{if(selection.size)setElementVisibility([...selection],false);};
el('show-selected').onclick=()=>{if(selection.size)setElementVisibility([...selection],true);};
el('isolate-selected').onclick=()=>{if(selection.size)isolateElements([...selection]);};
el('tree-grouping').onchange=renderElements;
el('system-filter').onchange=()=>{selectElement(null);renderSystemSummary();applySceneVisibility();};
el('visibility-filter').onchange=applySceneVisibility;
el('reset-visibility').onclick=()=>{rememberVisibility();hiddenOnly=false;visibility.reset();sceneMembers.forEach(m=>m.visible=true);levelFacet.reset();categoryFacet.reset();parameterFilters=[];renderParameterFilters();clipped=false;updateCut();el<HTMLSelectElement>('system-filter').value='';el<HTMLInputElement>('visibility-filter').checked=true;el<HTMLInputElement>('element-search').value='';el<HTMLInputElement>('parameter-name').value='';el<HTMLInputElement>('parameter-value').value='';el<HTMLSelectElement>('parameter-operator').value='contains';el<HTMLInputElement>('parameter-value').disabled=false;renderSystemSummary();applySceneVisibility();renderMembers();if(selectedId){el<HTMLButtonElement>('show-selected').disabled=false;el<HTMLButtonElement>('hide-selected').disabled=false;}viewer?.fit();};
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
function commitBrowserContext(append:boolean){if(!append){catalogues.clear();sourceChanges=[];document.querySelector('.source-update-banner')?.remove();}documentPanel.set(null);renderElements();


    closeCad();setMode('view');el('error').hidden=true;el('element-tree').innerHTML='';++generation;++modelGeneration;if(DEMO)project='browser-local';catalogueProject=project;el<HTMLSelectElement>('projects').innerHTML='<option>Локальный файл в браузере</option>';el<HTMLSelectElement>('runs').innerHTML='<option>Сценарий не рассчитан</option>';el<HTMLSelectElement>('models').innerHTML='<option>Чтение модели</option>';el<HTMLSelectElement>('scenes').innerHTML='<option value="">Выберите сцену</option>';document.querySelector('.notice')!.textContent=(DEMO?'Свой файл обрабатывается в браузере и не отправляется на сервер.':'Производная модель сохраняется в локальной базе проекта и доступна MCP.')+' Сценарий предварительный: технология, выработка и связи требуют проверки.';browserRun=null;for(const url of browserUrls)URL.revokeObjectURL(url);browserUrls.length=0;for(const key of ['projects','models','runs'])el<HTMLSelectElement>(key).disabled=true;}
const browser=browserPanel({publicDemo:DEMO,
  persistDocument:DEMO?undefined:async document=>{const target=project,restored=await saveProjectCatalog(target,document);if(target!==project)throw Error('Проект изменился');acceptDocument(restored);},
  containsSource:(sha,mode)=>sceneMembers.some(member=>sameReadSource(member.model,sha,mode))||!!model&&sameReadSource(model,sha,mode),
  persist:DEMO?undefined:async(pkg,binary,progress,cancelled)=>{const target=project,repo=new ReviewRepository(true,()=>target);await repo.registerModel(pkg,binary,progress,()=>cancelled()||target!==project);},
  openDocument:()=>documentPanel?.open(),
  noGeometry:(filename,message)=>{if(model&&loadedBinary){el('workspace-status').textContent=filename+': геометрия не прочитана; прежняя сцена сохранена.';return;}el('file-title').textContent=filename;el('geometry-kind').textContent='RVT · 3D недоступна';el<HTMLButtonElement>('mode-simulate').disabled=true;el<HTMLSelectElement>('models').innerHTML='<option>Геометрия не прочитана</option>';el('inspector-title').textContent='Результат чтения RVT';el('inspector').innerHTML=`<p><strong>${esc(filename)}</strong></p><p>${esc(message)}</p>`;},
  document:(data,message)=>{if(data)acceptDocument(data);else documentPanel.set(null,message);},
  drawing:openCad, cancelDrawing:closeCad,
  reset:()=>{},cancelPreparation:()=>{scenePreparation?.abort();revisionPreparation?.abort();},
  model:async(pkg,binary,append,intent)=>{
    const candidate:SceneMember={instanceId:pkg.model_id,model:pkg,binary,offset:[0,0,0],rotation:0,visible:true};
    const existing=append?(sceneMembers.length?sceneMembers:model&&loadedBinary?[{instanceId:model.model_id,model,binary:loadedBinary,offset:[0,0,0] as [number,number,number],rotation:0,visible:true}]:[]):[];
    if(existing.some(m=>m.instanceId!==intent?.replaceInstanceId&&sameReadSource(m.model,pkg.source.sha256,pkg.source.format==='rvt'?rvtMode(pkg):undefined)))throw new SourceAlreadyPresent();
    if(intent?.replaceInstanceId){
      const old=existing.find(member=>member.instanceId===intent.replaceInstanceId);if(!old||!model)throw Error('Исходная модель больше не найдена в сцене.');
      const previous=captureWorkspace(),before=model,controller=new AbortController();revisionPreparation?.abort();revisionPreparation=controller;
      try{
        await sceneStore('put',{...previous,id:crypto.randomUUID(),project_id:measurementProject,name:'До обновления · '+old.model.source.filename,created_at:new Date().toISOString()});
        browser.sceneProgress('Сравнение прочитанных идентификаторов и параметров ревизий');
        const comparison=await inspectRevision(old.model,pkg,controller.signal);
        if(controller.signal.aborted)throw Error('Обновление источника отменено.');
        const next=existing.map(member=>member===old?{...member,model:pkg,binary}:member);
        await presentMembers(next,()=>commitBrowserContext(true));
        if(!model)throw Error('Новая сцена не получена.');
        const remapped=remapRevisionState(previous.state,before,model,old.instanceId,new Map(comparison.mapping),previous.members.filter(member=>!member.visible).map(member=>member.instanceId));applyWorkspaceState(remapped.state);
        const change={before_sha256:old.model.source.sha256,after_sha256:pkg.source.sha256,before_model_id:old.model.model_id,after_model_id:pkg.model_id,before_importer_version:old.model.importer_version,after_importer_version:pkg.importer_version,created_at:new Date().toISOString(),report:comparison.report,unresolved_presentation_ids:remapped.unresolved};sourceChanges=[...sourceChanges,change];
        const note=document.querySelector('.notice')!;note.textContent='Источник обновлён. Предыдущая сцена сохранена. Замеры, виды, таблицы и проверки прежней ревизии требуют перепроверки. Не перенесено неоднозначных настроек элементов: '+remapped.unresolved+'.';
        const counts=document.createElement('span');counts.textContent=' Новых в прочитанном наборе: '+comparison.report.rows.filter(row=>row.kind==='added').length+'; не найдено в новом наборе: '+comparison.report.rows.filter(row=>row.kind==='removed').length+'; изменено: '+comparison.report.rows.filter(row=>row.kind==='changed').length+'; вопросов: '+comparison.report.rows.filter(row=>row.kind==='question').length+'.';note.append(counts);
        document.querySelector('.source-update-banner')?.remove();const banner=document.createElement('section');banner.className='source-update-banner';const message=document.createElement('span');message.textContent='Источник обновлён. Прежняя сцена сохранена. Замеры, виды, таблицы и проверки требуют перепроверки.';const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');summary.textContent='Изменения прочитанного набора';body.textContent=counts.textContent+' Не перенесено неоднозначных настроек: '+remapped.unresolved+'.';details.append(summary,body);const dismiss=document.createElement('button');dismiss.textContent='Скрыть сообщение';dismiss.onclick=()=>banner.remove();banner.append(message,details,dismiss);document.querySelector('.app-header')!.after(banner);recovery.dirty();return browserModel!;
      }finally{if(revisionPreparation===controller)revisionPreparation=null;}
    }
    await presentMembers([...existing,candidate],()=>commitBrowserContext(append));documentPanel.geometryReady(!!viewer&&!!model&&!model.federation&&pkg.statistics.meshes>0);el<HTMLDialogElement>('file-dialog').close();return browserModel!;
  },
  run:async(data)=>{setMode('simulate');browserRun=data;for(const url of browserUrls)URL.revokeObjectURL(url);browserUrls.length=0;el<HTMLSelectElement>('runs').innerHTML=`<option value="${esc(data.run_id)}">${esc(data.scenario.name||'Браузерный расчёт')}</option>`;await loadRun(data.run_id);el<HTMLDialogElement>('file-dialog').close();}
});
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
        browserModel=null;browserBinary=null;browserRun=null;catalogues.clear();documentPanel.set(null);closeCad();
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
initialLoad=(async()=>{try{const r=await fetch(DEMO?'./demo/projects.json':'/api/projects');const d=await r.json();if(project==='browser-local')return;el<HTMLSelectElement>('projects').innerHTML=d.projects.map((p:{id:string;name:string})=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');project=project||d.default_project;if(project){el<HTMLSelectElement>('projects').value=project;await loadProject(project,DEMO&&!!initialExample);await demoExamples();}else error('Сначала зарегистрируйте проект или запустите uvyazka demo.');}catch(e){error(e);}})();

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
function chooseModel(append:boolean){el<HTMLInputElement>('browser-append').checked=append;el<HTMLInputElement>('browser-file').click();}
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

const elementMenu=document.createElement('dialog');elementMenu.className='element-context-menu';elementMenu.setAttribute('aria-label','Действия с выбранными элементами');document.body.append(elementMenu);
el('element-tree').addEventListener('contextmenu',event=>{const row=(event.target as HTMLElement).closest<HTMLElement>('.element-item');if(!row?.dataset.id)return;event.preventDefault();if(!selection.has(row.dataset.id))selectElement(row.dataset.id);elementMenu.replaceChildren();for(const [title,action]of [['Скрыть',()=>setElementVisibility([...selection],false)],['Показать',()=>setElementVisibility([...selection],true)],['Только выбранные',()=>isolateElements([...selection])],['Инженерные связи',()=>{engineering.open(selectedId);inspectorTab(true);}]]as const){const b=document.createElement('button');b.textContent=title;b.onclick=()=>{action();elementMenu.close();};elementMenu.append(b);}const close=document.createElement('button');close.textContent='Закрыть';close.onclick=()=>elementMenu.close();elementMenu.append(close);elementMenu.showModal();});
