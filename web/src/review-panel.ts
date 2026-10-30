import {userMessage,addDiagnostics} from './ui-language.ts';
import {ReviewRepository} from './review-client';
import {newRule} from './review-model';
import type {ClashRule,ClashReport,ClashIssue,ReviewObject,ReviewSelector,IssueView} from './review-model';
import type {ModelPackage} from './model';
import type {ViewerState} from './viewer-workspace';
import {elementCategory} from './element-category';
import './review-panel.css';

type Actions={shared:boolean;project:()=>string;capture:()=>{state:ViewerState;model:ModelPackage;binary:ArrayBuffer};apply:(state:ViewerState)=>void;selection:()=>string[];matches:()=>string[];focus:(ids:string[])=>void;projection:()=>IssueView['projection'];snapshot:()=>string};
const e=<K extends keyof HTMLElementTagNameMap>(tag:K,value?:string)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;return n;};
const label=(name:string,input:HTMLElement)=>{const n=e('label',name);n.append(input);return n;};
  const statusNames:Record<string,string>={new:'Новое',review:'На проверке',confirmed:'Подтверждено',accepted:'Принято с обоснованием',resolved:'Устранено',reopened:'Открыто повторно',question:'Вопрос',stale:'Нужна перепроверка'};
function download(data:BlobPart,filename:string,type:string){const url=URL.createObjectURL(new Blob([data],{type}));const a=e('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export function reviewPanel(actions:Actions){
 const repo=new ReviewRepository(actions.shared,actions.project);const panel=e('aside');panel.className='review-panel';panel.hidden=true;panel.setAttribute('aria-label','Проверки модели');document.body.append(panel);
 let tab:'test'|'issues'|'views'='test',rule=newRule(),ruleRevision=0,report:ClashReport|null=null,runId='',busy=false,worker:Worker|undefined,jobId='',poll:ReturnType<typeof setTimeout>|undefined;
 let selectedIssue='',message='',savedRules:ReviewObject[]=[],runs:ReviewObject[]=[],views:ReviewObject[]=[],templates:ReviewObject[]=[],decisions:ReviewObject[]=[],activeProject='';
 let leftMode='all',rightMode='all';const issueViews:Record<string,IssueView>={};let cancelRequested=false;let jobRepo=repo;let sequence=0;
 let jobs:{job_id:string;status:string;heartbeat:string}[]=[];
 const button=e('button');button.id='open-review';button.setAttribute('aria-label','Проверки модели и сохранённые виды');button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h10v10H3zM11 10h10v10H11zM8 8l8 8"/></svg><span>Проверки</span>';document.getElementById('open-network')!.after(button);
 const act=(parent:HTMLElement,name:string,fn:()=>unknown,primary=false)=>{const b=e('button',name);b.type='button';if(primary)b.className='review-primary';b.onclick=()=>{Promise.resolve().then(fn).catch(fail);};parent.append(b);return b;};
 function fail(error:unknown){const raw=error instanceof Error?error.message:String(error);message=userMessage(raw);const p=panel.querySelector('[role=status]');if(p)p.textContent=message;panel.querySelector('.error-diagnostics')?.remove();if(message!==raw)addDiagnostics(panel,raw).classList.add('error-diagnostics');}
 function notify(text:string){message=text;const p=panel.querySelector('[role=status]');if(p)p.textContent=text;}
 async function refresh(){const project=actions.project();const data=await Promise.all(['clash_template','clash_run','view','view_template','issue'].map(k=>repo.list(k)));const history=actions.shared?await repo.request('jobs'):{items:[]};if(project!==actions.project())return;[savedRules,runs,views,templates,decisions]=data;jobs=history.items;render();}
 button.onclick=()=>{panel.hidden=!panel.hidden;if(!panel.hidden){if(activeProject!==actions.project()){activeProject=actions.project();rule=newRule();ruleRevision=0;report=null;runId='';}render();void refresh().catch(fail);}};
 function matched(selector:ReviewSelector,model:ModelPackage){return model.elements.filter(x=>x.role==='element'&&(Object.entries(selector) as [string,string[]][]).every(([k,values])=>!values?.length||k==='ids'&&values.includes(x.id)||k==='categories'&&values.includes(elementCategory(x,model).key)||k==='classes'&&values.some(v=>x.hierarchy.includes(v)||x.class===v)||k==='models'&&values.includes(x.source_instance_id??model.model_id)||k==='levels'&&values.includes(x.storey_id??'')||k==='systems'&&model.systems?.some(s=>values.includes(s.id)&&s.member_ids.includes(x.id))));}
 function render(){
  const focused=panel.querySelector<HTMLInputElement>('input:focus');const focus=focused?{name:focused.getAttribute('aria-label'),start:focused.selectionStart}:null;
  panel.replaceChildren();const header=e('header');const title=e('div');title.append(e('small',actions.shared?'ОБЩАЯ БАЗА ПРОЕКТА':'НА ЭТОМ УСТРОЙСТВЕ'),e('h2','Проверки модели'));header.append(title);act(header,'Закрыть',()=>panel.hidden=true).setAttribute('aria-label','Закрыть проверки модели');panel.append(header);
  const nav=e('nav');for(const [id,name]of [['test','Проверка'],['issues','Замечания'+(report?' · '+report.issues.length:'')],['views','Виды и шаблоны']]as const){const b=act(nav,name,()=>{tab=id;render();});b.setAttribute('aria-pressed',String(tab===id));}panel.append(nav);
  const status=e('p',message||'Выберите состав A и B, задайте правило и запустите проверку.');status.className='review-status';status.setAttribute('role','status');panel.append(status);
  const body=e('section');body.className='review-body';panel.append(body);
  if(tab==='test')test(body);else if(tab==='issues')issues(body);else savedViews(body);
  if(focus?.name){const input=panel.querySelector<HTMLInputElement>('input[aria-label="'+CSS.escape(focus.name)+'"]');input?.focus();if(input&&focus.start!==null&&input.type==='text')input.setSelectionRange(focus.start,focus.start);}
 }
 function input(parent:HTMLElement,name:string,value:string,change:(v:string)=>void,type='text'){const field=e('input');field.type=type;field.value=value;field.setAttribute('aria-label',name);field.oninput=()=>change(field.value);parent.append(label(name,field));return field;}
 function select(parent:HTMLElement,name:string,options:[string,string][],value:string,change:(v:string)=>void){const field=e('select');for(const [v,n]of options)field.add(new Option(n,v));field.value=value;field.setAttribute('aria-label',name);field.onchange=()=>{Promise.resolve().then(()=>change(field.value)).catch(fail);};parent.append(label(name,field));return field;}
 function multi(parent:HTMLElement,name:string,options:[string,string][],values:string[],change:(values:string[])=>void){const control=e('select');control.multiple=true;control.size=Math.min(6,Math.max(2,options.length));control.setAttribute('aria-label',name);for(const [id,title]of options){const option=new Option(title,id);option.selected=values.includes(id);control.add(option);}control.onchange=()=>change([...control.selectedOptions].map(o=>o.value));parent.append(label(name,control));}
 function selector(parent:HTMLElement,side:'left'|'right',model:ModelPackage){
  const letter=side==='left'?'A':'B',container=e('fieldset');container.append(e('legend','Состав '+letter));const current=rule[side];
  select(container,'Выбор '+letter,[['all','По условиям'],['selection','Выделенные элементы'],['matches','Результаты поиска']],side==='left'?leftMode:rightMode,v=>{if(side==='left')leftMode=v;else rightMode=v;current.ids=v==='selection'?actions.selection():v==='matches'?actions.matches():[];if(v!=='all'&&!current.ids.length){current.ids=['__empty_selection__'];notify('Выборка '+letter+' пуста — проверьте выделение / поиск.');}render();});
  const categories=new Map<string,string>();for(const element of model.elements){const c=elementCategory(element,model);if(element.role==='element')categories.set(c.key,c.format+' · '+c.name);}
  multi(container,'Категории '+letter,[...categories].sort((a,b)=>a[1].localeCompare(b[1])),current.categories??[],v=>{current.categories=v;render();});
  const more=e('details');more.append(e('summary','Файлы, уровни и системы'));
  const sources=model.federation?.members.map(m=>[m.instance_id,m.label]as[string,string])??[[model.model_id,model.source.filename]as[string,string]];
  multi(more,'Модели '+letter,sources,current.models??[],v=>{current.models=v;render();});multi(more,'Уровни '+letter,model.storeys.map(s=>[s.id,s.name]),current.levels??[],v=>{current.levels=v;render();});multi(more,'Системы '+letter,(model.systems??[]).map(s=>[s.id,s.name]),current.systems??[],v=>{current.systems=v;render();});container.append(more,e('p',`В прочитанных данных: ${matched(current,model).length} элементов. Пустые условия не ограничивают выбор.`));parent.append(container);
 }
 function test(parent:HTMLElement){
  if(savedRules.length)select(parent,'Сохранённая проверка',[['','Выберите шаблон'],...savedRules.map(r=>[r.id,String(r.payload.name)]as[string,string])],'',id=>{const row=savedRules.find(r=>r.id===id);if(row){rule=structuredClone(row.payload) as unknown as ClashRule;ruleRevision=row.revision;render();}});
  input(parent,'Название проверки',rule.name,v=>rule.name=v);
  select(parent,'Что проверяем',[['hard','Пересечение геометрии'],['clearance','Недостаточный зазор'],['service','Зона обслуживания']],rule.kind,v=>{rule.kind=v as ClashRule['kind'];render();});
  let model:ModelPackage;try{model=actions.capture().model;}catch{parent.append(e('p','Откройте модель, чтобы выбрать элементы для проверки.'));return;}
  if(rule.kind!=='service')selector(parent,'left',model);else zoneEditor(parent,model);
  const arrow=e('div','A ↔ B');arrow.className='review-pair';parent.append(arrow);selector(parent,'right',model);
  const numbers=e('div');numbers.className='review-numbers';input(numbers,'Допуск, мм',String(rule.tolerance_mm),v=>rule.tolerance_mm=Number(v),'number');if(rule.kind==='clearance')input(numbers,'Требуемый зазор, мм',String(rule.clearance_mm),v=>rule.clearance_mm=Number(v),'number');parent.append(numbers);
  const limits=e('details');limits.append(e('summary','Бюджет и исключения'));input(limits,'Максимум пар',String(rule.max_pairs),v=>rule.max_pairs=Number(v),'number');input(limits,'Максимум треугольных запросов',String(rule.max_triangle_tests),v=>rule.max_triangle_tests=Number(v),'number');input(limits,'Максимум замечаний',String(rule.max_results),v=>rule.max_results=Number(v),'number');limits.append(e('p',`Исключений: ${rule.excluded_pairs.length}. Они действуют только для указанного хеша источника.`));parent.append(limits);
  const controls=e('div');controls.className='review-actions';act(controls,'Сохранить шаблон',async()=>{const result=await repo.save('clash_template',rule.id,rule as unknown as Record<string,unknown>,ruleRevision);ruleRevision=result.revision;notify('Шаблон сохранён.');await refresh();}).disabled=busy;
  act(controls,'Новая проверка',()=>{rule=newRule();ruleRevision=0;leftMode=rightMode='all';render();}).disabled=busy;
  act(controls,busy?'Проверка выполняется…':'Запустить проверку',start,true).disabled=busy;
  if(busy)act(controls,'Отменить',cancel);parent.append(controls,e('p','Касания учитываются отдельно. Непрочитанная и приближённая геометрия не подтверждает отсутствие коллизий.'));
 }
 function zoneEditor(parent:HTMLElement,model:ModelPackage){
  const group=e('fieldset');group.append(e('legend','A · явно заданные зоны обслуживания'));const values:HTMLInputElement[]=[];
  for(const name of ['X min','Y min','Z min','X max','Y max','Z max'])values.push(input(group,name+' зоны, м','',()=>{},'number'));
  const basis=input(group,'Основание габаритов зоны','',()=>{});
  act(group,'Добавить зону для выделенного элемента',()=>{const ids=actions.selection();if(ids.length!==1||!model.elements.some(e=>e.id===ids[0]))throw Error('Выделите один элемент — владелец зоны');if(!basis.value.trim()||values.some(v=>!v.value.trim()))throw Error('Заполните все шесть координат в метрах и основание');rule.zones.push({id:crypto.randomUUID(),owner_id:ids[0],bbox_min_m:values.slice(0,3).map(v=>Number(v.value)),bbox_max_m:values.slice(3).map(v=>Number(v.value)),basis:basis.value.trim()});render();});
  for(const z of rule.zones){const row=e('p',z.owner_id+' · '+z.basis);act(row,'Убрать зону',()=>{rule.zones=rule.zones.filter(x=>x.id!==z.id);render();});group.append(row);}parent.append(group);
 }
 function browserWorker(){if(!worker){worker=new Worker(new URL('./review.worker.ts',import.meta.url),{type:'module'});worker.onerror=err=>{busy=false;fail(err.message);render();};}return worker;}
 function stopPoll(){if(poll)clearTimeout(poll);poll=undefined;}
 async function start(){
  const captured=actions.capture(),project=actions.project(),token=++sequence;
  const repository=new ReviewRepository(actions.shared,()=>project);jobRepo=repository;
  busy=true;cancelRequested=false;jobId='';report=null;message='Подготовка проверки…';render();
  try{
   if(actions.shared){
    const sceneId=await repository.scene(captured.model,captured.binary,notify,()=>cancelRequested);
    if(cancelRequested)throw Error('Подготовка отменена. Уже переданные блоки сохранены.');
    const job=await repository.start(sceneId,structuredClone(rule));jobId=job.job_id;
    void pollJob(project,repository,jobId,token);
   }else{
    const id=crypto.randomUUID();runId=id;const w=browserWorker();let partial:ClashReport|null=null;
    w.onmessage=async({data})=>{
     if(data.id!==id)return;
     const current=token===sequence&&project===actions.project();
     try{
      if(data.kind==='progress'){
       if(data.partial){const old=partial?.issues??[];partial={...data.partial,issues:[...old,...(data.issues_delta??[])],contacts:[]};partial!.job_id=id;if(current)report=partial;}
       if(current)notify(data.text??(data.coverage.phase==='preparing_geometry'?`Подготовлена геометрия: ${data.coverage.prepared_elements} / ${data.coverage.selected_elements}`:`Проверено пар: ${data.coverage.checked_pairs} · треугольных запросов: ${data.coverage.triangle_tests} · найдено: ${data.found}`));
      }else if(data.kind==='result'){
       const finished=data.report as ClashReport;finished.job_id=id;
       await repository.save('clash_run',id,finished as unknown as Record<string,unknown>);
       if(!current)return;busy=false;report=finished;tab='issues';message=coverageText(finished);await refresh();
      }else if(data.kind==='error'&&current){busy=false;fail(data.message);render();}
     }catch(ex){if(current){busy=false;fail(ex);render();}}
    };
    w.postMessage({id,kind:'run',base:new URL('.',location.href).href,model:captured.model,binary:captured.binary,rule:structuredClone(rule)});
   }
  }catch(ex){if(token===sequence){busy=false;fail(ex);render();}}
 }
 async function pollJob(project:string,repository=jobRepo,key=jobId,token=sequence){
  if(token!==sequence)return;
  try{
   const value=await repository.job(key);
   if(token!==sequence)return;
   if(project!==actions.project()){stopPoll();busy=false;notify('Проект сменился. Задание сохранено в исходном проекте.');return;}
   if(value.report){report=value.report;runId=key;notify(coverageText(report));}
   if(value.activity){busy=false;stopPoll();tab='issues';message='Давно нет обновления задания. Полнота не подтверждена; откройте журнал или запустите проверку заново.';render();}
   else if(['queued','running'].includes(value.status)){if(value.report?.coverage.phase==='preparing_geometry')notify(`Подготовлена геометрия: ${value.report.coverage.prepared_elements} / ${value.report.coverage.selected_elements}`);poll=setTimeout(()=>{void pollJob(project,repository,key,token);},1000);}
   else{busy=false;tab='issues';message=value.error??(report?coverageText(report):value.status);await refresh();}
  }catch(ex){if(token===sequence){busy=false;fail(ex);render();}}
 }
 async function cancel(){
  cancelRequested=true;
  if(actions.shared){if(jobId)await jobRepo.request('cancel',{job_id:jobId});notify('Запрошена отмена; ожидаем остановки задания.');}
  else{sequence++;worker?.terminate();worker=undefined;busy=false;if(report){report.status='cancelled';report.complete=false;report.stop_reason='Cancelled after last checkpoint; in-progress pair is not counted';await jobRepo.save('clash_run',runId,report as unknown as Record<string,unknown>);}message='Проверка отменена. Сохранён последний контрольный результат; полнота не подтверждена.';await refresh();}
 }
 function coverageText(r:ClashReport){return `${r.status==='complete'?'Расчёт завершён':r.status==='partial'?'Остановлен по бюджету':r.status} · пар ${r.coverage.checked_pairs} · замечаний ${r.issues.length} · ${r.complete?'выбранный прочитанный состав проверен':'есть непроверенный объём / вопросы'}`;}
 function ensureScene(){const state=actions.capture().state;if(!report||state.model_id!==report.model_id||state.source_sha256!==report.source_sha256)throw Error('Откройте ту модель и ревизию, на которой выполнена проверка');}
 function issues(parent:HTMLElement){
  if(actions.shared&&jobs.length){const journal=e('details');journal.open=!report;journal.append(e('summary','Журнал заданий · '+jobs.length));for(const job of jobs){const row=e('article');row.append(e('small',job.status+' · '+job.heartbeat.slice(0,19)));act(row,'Открыть задание '+job.job_id.slice(0,8),async()=>{stopPoll();jobId=job.job_id;runId=jobId;report=null;selectedIssue='';const project=actions.project();jobRepo=new ReviewRepository(true,()=>project);busy=true;render();await pollJob(project,jobRepo,jobId,++sequence);});journal.append(row);}act(journal,'Обновить журнал',refresh);parent.append(journal);}
  if(runs.length)select(parent,'Сохранённый прогон',[['','Выберите прогон'],...runs.map(r=>[r.id,String((r.payload.rule as {name?:string})?.name??r.id)+' · '+r.created_at?.slice(0,16)]as[string,string])],runId,async id=>{if(!id)return;const row=await repo.get('clash_run',id);report=row.payload as unknown as ClashReport;runId=id;selectedIssue='';message=coverageText(report);render();});
  if(!report){parent.append(e('h3',runs.length?'Откройте сохранённый прогон':'Проверок пока нет'),e('p','Выберите результат выше или задайте новую проверку.'));return;}
  const exports=e('div');exports.className='review-actions';for(const fmt of ['bcf','xlsx','json'])act(exports,fmt==='bcf'?'BCF 3.0':fmt==='xlsx'?'Excel':'JSON',()=>exportReport(fmt)).disabled=busy||(actions.shared&&!runs.some(r=>r.id===runId));parent.append(exports);
  const coverage=e('details');coverage.append(e('summary','Охват и исходная ревизия'),e('p','Источник: '+report.source_filename+' · '+report.source_sha256),e('p',coverageText(report)));coverage.append(e('pre',JSON.stringify(report.coverage,null,2)));if(report.stop_reason)coverage.append(e('p',report.stop_reason));parent.append(coverage);
  if(!report.issues.length)parent.append(e('h3',report.complete?'Пересечений по выбранному правилу не найдено':'Нет замечаний, но полнота не подтверждена'));
  const list=e('div');list.className='review-issues';
  for(const row of report.issues.slice(0,500)){
   const decision=decisions.find(d=>d.id===row.id)?.payload;const valid=decision?.source_sha256===report.source_sha256&&decision?.geometry_sha256===report.geometry_sha256;
   const item=e('article');item.className='review-issue';item.dataset.selected=String(selectedIssue===row.id);const b=act(item,row.a.name+' ↔ '+row.b.name,()=>{ensureScene();selectedIssue=row.id;actions.focus([row.a.id,row.b.id]);render();});b.className='review-issue-title';
   item.append(e('small',(statusNames[String(valid?decision!.status:decision?'stale':row.status)]??row.status)+' · '+(row.kind==='intersection'?'пересечение':row.kind==='clearance'?'зазор':'вопрос')));
   if(row.kind==='clearance'&&row.evidence.distance_m!==undefined)item.append(e('p',`Расстояние по сеткам: ${(row.evidence.distance_m*1000).toLocaleString('ru-RU')} мм`));
   if(selectedIssue===row.id){
    const reasonText=row.reason==='Intersection/distance in the extracted meshes; review required'?'Найдено по прочитанной геометрии. Проверьте решение и условия проекта.':row.reason==='Approximate, fragment or uncertain geometry'?'Приближённая, незамкнутая или неоднозначная геометрия требует проверки.':row.reason;
    item.append(e('p','A · '+row.a.class+' · '+(row.a.revit_id?'Revit '+row.a.revit_id:row.a.ifc_guid??row.a.id)),e('p','B · '+row.b.class+' · '+(row.b.revit_id?'Revit '+row.b.revit_id:row.b.ifc_guid??row.b.id)),e('p',reasonText));
    if(valid&&decision?.view)act(item,'Восстановить сохранённый вид',()=>{ensureScene();actions.apply(decision.view as ViewerState);notify('Камера, разрез и видимость восстановлены.');});
    const status=select(item,'Статус замечания',Object.entries(statusNames),String(valid?decision!.status:row.status),()=>{});const reason=input(item,'Причина решения',String(decision?.reason??''),()=>{});const actor=input(item,'Автор решения',String(decision?.actor??'Локальный пользователь'),()=>{});
    act(item,'Сохранить решение и текущий вид',async()=>{ensureScene();if(!reason.value.trim()||!actor.value.trim())throw Error('Укажите причину и автора решения');const capture=actions.capture();const view:IssueView={state:capture.state,projection:actions.projection(),snapshot:actions.snapshot(),isolate_pair:true};issueViews[row.id]=view;const existing=decisions.find(d=>d.id===row.id);await repo.save('issue',row.id,{status:status.value,reason:reason.value.trim(),actor:actor.value.trim(),source_sha256:report!.source_sha256,geometry_sha256:report!.geometry_sha256,run_id:runId,view:view.state,projection:view.projection,snapshot:view.snapshot,isolate_pair:true},existing?.revision??0);message='Решение и вид сохранены с исходной ревизией.';await refresh();});
    act(item,'Исключить пару для этой ревизии',()=>{if(!reason.value.trim())throw Error('Укажите обоснование исключения');rule=structuredClone(report!.rule);rule.excluded_pairs.push({a:row.a.id,b:row.b.id,reason:reason.value.trim(),source_sha256:report!.source_sha256});ruleRevision=savedRules.find(x=>x.id===rule.id)?.revision??0;tab='test';notify('Исключение добавлено в редактируемый шаблон. Сохраните его и выполните новый прогон.');render();});
   }list.append(item);
  }parent.append(list);if(report.issues.length>500)parent.append(e('p','Показаны первые 500 замечаний; экспорт содержит все результаты.'));
  if(runs.length>1){const box=e('details');box.append(e('summary','Сравнить с предыдущим прогоном'));const baseline=select(box,'Базовый прогон',runs.filter(r=>r.id!==runId).map(r=>[r.id,String((r.payload.rule as {name?:string})?.name??r.id)]),runs.find(r=>r.id!==runId)?.id??'',()=>{});const confirm=e('input');confirm.type='checkbox';box.append(label('Подтверждаю общность исходной модели и неизменность размещения',confirm));act(box,'Сравнить прогоны',async()=>{if(!actions.shared)throw Error('Сравнение между прогонами через общую базу доступно в локальной Увязке / Tauri');const diff=await repo.request('compare',{before_id:baseline.value,after_id:runId,lineage_confirmed:confirm.checked});box.append(e('pre',JSON.stringify(diff,null,2)));});parent.append(box);}
 }
 async function exportReport(format:string){if(!report)return;
  if(actions.shared){const url='/api/review3d/export?project_id='+encodeURIComponent(actions.project())+'&run_id='+encodeURIComponent(runId)+'&format='+format;const r=await fetch(url);if(!r.ok)throw Error((await r.json()).error);download(await r.blob(),'uvyazka-issues.'+format,r.headers.get('Content-Type')??'application/octet-stream');notify('Ведомость выгружена.');return;}
  const id=crypto.randomUUID(),w=browserWorker();notify('Подготовка '+format.toUpperCase()+' на устройстве…');
  const savedViews:Record<string,IssueView>={...issueViews};const current=structuredClone(report);for(const issue of current.issues){const d=decisions.find(x=>x.id===issue.id)?.payload;if(d?.source_sha256===current.source_sha256&&d.geometry_sha256===current.geometry_sha256){issue.status=String(d.status);issue.reason=String(d.reason);issue.actor=String(d.actor);if(d.view)savedViews[issue.id]={state:d.view as ViewerState,projection:d.projection as IssueView['projection'],snapshot:d.snapshot as string,isolate_pair:true};}else if(d){issue.status='stale';}}
  if(format==='json'){download(JSON.stringify(current,null,2),'uvyazka-issues.json','application/json');return;}
  w.onmessage=({data})=>{if(data.id!==id)return;if(data.kind==='export'){const raw=Uint8Array.from(atob(data.data),(c:string)=>c.charCodeAt(0));download(raw.buffer,'uvyazka-issues.'+format,format==='bcf'?'application/octet-stream':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');notify('Ведомость выгружена.');}else if(data.kind==='error')fail(data.message);else if(data.kind==='progress')notify(data.text);};w.postMessage({id,kind:'export',base:new URL('.',location.href).href,report:current,views:savedViews,format});
 }
 function savedViews(parent:HTMLElement){
  input(parent,'Название вида или шаблона','',()=>{});const name=()=>panel.querySelector<HTMLInputElement>('input[aria-label="Название вида или шаблона"]')!.value.trim();
  const controls=e('div');controls.className='review-actions';act(controls,'Сохранить вид',async()=>{const capture=actions.capture();if(!name())throw Error('Назовите вид');await repo.save('view',crypto.randomUUID(),{name:name(),state:capture.state,projection:actions.projection()});message='Именованный вид сохранён.';await refresh();});
  act(controls,'Сохранить шаблон отображения',async()=>{const capture=actions.capture();if(!name())throw Error('Назовите шаблон');await repo.save('view_template',crypto.randomUUID(),{name:name(),basis_model_id:capture.state.model_id,filters:capture.state.filters,xray:capture.state.view.xray});message='Шаблон отображения сохранён.';await refresh();});parent.append(controls);
  for(const [title,rows]of [['Сохранённые виды',views],['Шаблоны отображения',templates]]as const){parent.append(e('h3',title));if(!rows.length)parent.append(e('p','Пока нет сохранённых объектов.'));for(const row of rows){const item=e('article');item.className='review-issue';item.append(e('strong',String(row.payload.name)),e('small','Ревизия '+row.revision));act(item,'Применить',()=>{if(row.kind==='view')actions.apply(row.payload.state as ViewerState);else{const captured=actions.capture().state;const filters=row.payload.filters as ViewerState['filters'];if(row.payload.basis_model_id!==captured.model_id&&(filters.levels.length||filters.system||filters.parameters.length))throw Error('Шаблон содержит привязки исходной модели. Проверьте соответствие уровней, систем и параметров.');actions.apply({...captured,filters,view:{...captured.view,xray:row.payload.xray as boolean}});}notify('Сохранённое представление применено.');});parent.append(item);}}
 }
 return {open:()=>{panel.hidden=false;render();void refresh().catch(fail);}};
}
