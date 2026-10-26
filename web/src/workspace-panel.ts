import {sceneStore,sharedWorkspace} from './viewer-workspace';
import type {SavedScene,ViewerState,SelectionSet} from './viewer-workspace';
import {compareRevisions} from './revision-diff';
import type {ModelPackage} from './model';
export function workspacePanel(actions:{project:()=>string;capture:()=>Omit<SavedScene,'id'|'name'|'created_at'|'project_id'>;restore:(scene:SavedScene)=>Promise<void>;apply:(state:ViewerState)=>void;matches:()=>string[];selection:()=>string[];show:(ids:string[])=>void;highlight:(ids:string[])=>void;error:(e:unknown)=>void;shared:boolean}){
 const dialog=document.createElement('dialog');dialog.className='viewer-workspace-dialog';dialog.setAttribute('aria-label','Рабочее место, подборки и ревизии');document.body.append(dialog);
 let baseline:ModelPackage|null=null,sharedRevision:number|undefined,sharedProject='';
 const key=()=>'uvyazka:selection-sets:v1:'+encodeURIComponent(actions.project());
 function sets():SelectionSet[]{const rows=JSON.parse(localStorage.getItem(key())??'[]');if(!Array.isArray(rows))throw Error('Повреждены подборки');return rows;}
 function putSets(rows:SelectionSet[]){localStorage.setItem(key(),JSON.stringify(rows));}
 const add=(parent:HTMLElement,tag:string,text:string)=>{const e=document.createElement(tag);e.textContent=text;parent.append(e);return e;};
 const click=(parent:HTMLElement,text:string,run:()=>unknown)=>{const button=add(parent,'button',text)as HTMLButtonElement;button.type='button';button.onclick=async()=>{button.disabled=true;try{await run();}catch(e){actions.error(e);}finally{button.disabled=false;}};return button;};
 async function render(){
  dialog.replaceChildren();const head=add(dialog,'div','');head.className='panel-head';add(head,'h2','Рабочее место');click(head,'Закрыть',()=>dialog.close());
  const body=add(dialog,'div','');body.className='dialog-content';const status=add(body,'p','');status.setAttribute('role','status');
  const label=add(body,'label','Название снимка');const name=document.createElement('input');name.placeholder='Проверка оборудования · вариант 1';name.maxLength=120;label.append(name);
  add(body,'p','Снимок сохраняет состав сцены и размещения, производную геометрию, камеру, сечения, видимость, фильтры, подборки и журнал замеров. Исходные RVT/IFC не сохраняются.');
  click(body,'Сохранить в этом браузере',async()=>{const scene:SavedScene={...actions.capture(),id:crypto.randomUUID(),project_id:actions.project(),name:name.value.trim()||'Рабочее место',created_at:new Date().toISOString()};scene.state.sets=sets();await sceneStore('put',scene);await render();});
  const list=add(body,'div','');list.className='workspace-snapshots';
  const scenes=(await sceneStore('list','')as SavedScene[]).filter(s=>s.project_id===actions.project()).sort((a,b)=>b.created_at.localeCompare(a.created_at));
  for(const scene of scenes){const row=add(list,'div','');row.className='workspace-snapshot';add(row,'strong',scene.name);add(row,'small',new Date(scene.created_at).toLocaleString()+' · '+scene.model.source.filename);
   click(row,'Открыть',async()=>{await actions.restore(scene);putSets(scene.state.sets);dialog.close();});
   click(row,'Сравнить с текущей',()=>{baseline=scene.model;renderDiff();});
   click(row,'Удалить снимок',async()=>{await sceneStore('delete',scene.id);await render();});
  }
  if(!scenes.length)add(list,'p','Сохранённых рабочих мест пока нет.');
  if(actions.shared){const shared=add(body,'details','');add(shared,'summary','Общая база проекта · человек и MCP');add(shared,'p','В SQLite передаётся состояние и наблюдения, без геометрии. Для восстановления нужен тот же пакет модели. Запись проверяет ревизию, старые версии сохраняются.');
   if(sharedProject!==actions.project()){sharedRevision=undefined;sharedProject=actions.project();}
   click(shared,'Прочитать из базы',async()=>{const project=actions.project(),data=await sharedWorkspace(project,'get');if(project!==actions.project())throw Error('Проект изменился');if(data.state)actions.apply(data.state);sharedRevision=data.revision;if(data.state)putSets(data.state.sets);status.textContent=data.state?`Прочитана ревизия ${data.revision}`:'Состояние в базе ещё не записано';});
   click(shared,'Сохранить в базу',async()=>{const project=actions.project();if(sharedRevision===undefined){const old=await sharedWorkspace(project,'get');if(old.revision)throw Error('В базе уже есть рабочее место. Сначала прочитайте его, чтобы не перезаписать чужие изменения.');sharedRevision=0;}const state=actions.capture().state;state.sets=sets();const data=await sharedWorkspace(project,'save',state,sharedRevision);if(project===actions.project())sharedRevision=data.revision;status.textContent=`В базе сохранена ревизия ${data.revision}`;});
  }
  const groups=add(body,'details','')as HTMLDetailsElement;groups.open=true;add(groups,'summary','Подборки элементов');
  const setName=document.createElement('input');setName.placeholder='Имя подборки';setName.setAttribute('aria-label','Название подборки');setName.maxLength=120;groups.append(setName);
  function saveSet(kind:'explicit'|'rule'){const state=actions.capture().state,ids=kind==='explicit'?actions.selection():actions.matches();if(kind==='explicit'&&!ids.length)throw Error('Выберите элементы через Ctrl + щелчок');const row:SelectionSet={id:crypto.randomUUID(),name:setName.value.trim()||'Подборка',kind,ids:kind==='explicit'?ids:[],model_id:state.model_id,source_sha256:state.source_sha256,created_at:new Date().toISOString(),...(kind==='rule'?{filters:state.filters}:{})};putSets([...sets(),row]);void render();}
  click(groups,'Сохранить выбранные',()=>saveSet('explicit'));click(groups,'Сохранить условия поиска',()=>saveSet('rule'));
  for(const set of sets()){
   const row=add(groups,'div','');row.className='workspace-snapshot';add(row,'strong',set.name+' · '+(set.kind==='rule'?'условия':'элементы'));add(row,'small','Источник '+set.source_sha256.slice(0,12));
   click(row,'Открыть подборку',()=>{const state=actions.capture().state;if(set.model_id!==state.model_id||set.source_sha256!==state.source_sha256)throw Error('Подборка относится к другой модели / ревизии. Автоматическое сопоставление не выполнено.');if(set.kind==='rule'&&set.filters){actions.apply({...state,filters:set.filters});actions.show(actions.matches());}else actions.show(set.ids);dialog.close();});
   click(row,'Удалить подборку',()=>{putSets(sets().filter(s=>s.id!==set.id));void render();});
  }
  const diff=add(body,'details','')as HTMLDetailsElement;add(diff,'summary','Сравнение ревизий');const diffHost=add(diff,'div','');
  function renderDiff(){diff.open=true;diffHost.replaceChildren();add(diffHost,'p',baseline?'База: '+baseline.source.filename:'Выберите снимок как базу или запомните текущую модель.');
   click(diffHost,'Запомнить текущую как базу',()=>{baseline=actions.capture().model;renderDiff();});
   const check=add(diffHost,'label','')as HTMLLabelElement;const input=document.createElement('input');input.type='checkbox';check.append(input,document.createTextNode('Это ревизии одной модели в одинаковом размещении'));
   click(diffHost,'Сравнить',()=>{if(!baseline)throw Error('Не выбрана базовая ревизия');const report=compareRevisions(baseline,actions.capture().model,input.checked);const out=add(diffHost,'div','');add(out,'p',report.limitations);for(const kind of ['added','removed','changed','question']as const){const rows=report.rows.filter(r=>r.kind===kind),names={added:'Добавлено',removed:'Удалено',changed:'Изменено',question:'Вопросы'};const group=add(out,'details','');add(group,'summary',`${names[kind]} · ${rows.length}`);if(kind!=='removed')click(group,'Подсветить',()=>actions.highlight(rows.flatMap(r=>r.after_id?[r.after_id]:[])));for(const row of rows.slice(0,200))add(group,'p',row.name+' · '+row.key+(row.changes.length?' · '+row.changes.join(', '):''));if(rows.length>200)add(group,'p','Полный список — в JSON.');}click(out,'Скачать сравнение JSON',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='revision-comparison.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});});
  }renderDiff();
 }
 document.getElementById('open-workspace')!.onclick=()=>{void render().then(()=>dialog.showModal()).catch(actions.error);};
 return {sets,putSets};
}
