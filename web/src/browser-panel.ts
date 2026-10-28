import {isNavisFormat} from './navis-format.ts';
import {importBatch,batchSummary} from './import-batch.ts';
import type {FileImportResult} from './import-batch.ts';
import {modelCoverage} from './model-coverage.ts';
import type {CoverageItem} from './model-coverage.ts';
import {importErrorMessage,SourceAlreadyPresent} from './import-errors.ts';
import {chooseNwdUnits} from './nwd-unit-dialog';
import {processingPanel} from './processing-panel';
import {geometryCache} from './geometry-cache';
import type { ModelPackage } from './model';
import type { RunPackage } from './simulation';
import { journalPanel } from './import-journal-panel';
import { filePolicy } from './import-journal';
import type { RunState, ImportRun } from './import-journal';
import type {RvtDocument} from './rvt-document';
import {hasReadableDocument} from './rvt-import-result';

export interface ImportIntent {replaceInstanceId?:string}
export type BrowserRun=RunPackage & {cpm:{duration_minutes:number;operations:Record<string,{critical:boolean}>}};
export function browserPanel(callbacks:{reset:(append:boolean)=>void;containsSource?:(sha:string)=>boolean;cancelPreparation?:()=>void;persist?:(model:ModelPackage,binary:ArrayBuffer,progress:(text:string)=>void,cancelled:()=>boolean)=>Promise<void>;persistDocument?:(document:RvtDocument)=>Promise<void>;publicDemo?:boolean;openDocument:()=>void;noGeometry:(filename:string,message:string)=>void;document:(data:RvtDocument|null,message?:string)=>void;drawing:(file:File)=>Promise<void>;cancelDrawing:()=>void;model:(model:ModelPackage,binary:ArrayBuffer,append:boolean,intent?:ImportIntent)=>Promise<ModelPackage>;run:(run:BrowserRun)=>void|Promise<void>}) {
  const section=document.createElement('section');section.className='panel browser-import';section.innerHTML=`
<h2>Открыть файл</h2>
<p>Файл остаётся на вашем устройстве. Для RVT и IFC прежний порог размера снят; большие модели требуют больше памяти. DWG/DXF до 64 MiB. Чтение RVT экспериментальное; Revit и агент не нужны.</p>
<div class="browser-actions"><label>DWG / RVT / IFC / NWD / NWC<input id="browser-file" type="file" accept=".dwg,.dxf,.rvt,.ifc,.nwd,.nwc" multiple></label><button id="browser-cancel" disabled>Отменить</button><button id="browser-demo">Учебный пример</button><button id="browser-log">Журнал обработки</button><button id="browser-document">Виды и таблицы</button></div>
<label class="check"><input id="browser-append" type="checkbox">Добавить IFC / RVT / NWD к открытой сцене</label><button id="browser-clear-cache">Очистить кеш IFC</button>
<p id="browser-status" role="status" aria-live="polite">Выберите файл или изучите готовый пример ниже.</p>
<details><summary>Память и большие модели</summary><label>Бюджет IFC-декодера<select id="browser-memory"><option value="512">512 MiB</option><option value="1024" selected>1 GiB</option><option value="2048">2 GiB</option></select></label><p>Это бюджет IFC-движка, а не всей вкладки. RVT, промежуточный IFC и 3D требуют дополнительной памяти. Технический предел RVT-читателя — 2 GiB входного файла; успешное чтение такого размера не гарантируется.</p></details>
<div class="browser-actions simulation-only"><label>Ресурсы<select id="browser-variant"><option value="base">Базовые</option><option value="reinforced">Усиленные</option></select></label><label>Доступность ресурсов<select id="browser-capacity"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label><label>Выдержка бетона, суток<input id="browser-curing" type="number" min="1" max="365" value="28"></label><button id="browser-plan" disabled>Рассчитать сценарий</button></div>
<p class="simulation-only">Работы, технология, выработка и связи — предварительные допущения IFCCS. Стадии RVT в браузере пока не читаются; существующие и демонтируемые элементы автоматически не исключаются.</p>
<div class="browser-actions"><a id="browser-ifc" hidden>Скачать IFC</a><a id="browser-report" hidden>Диагностика JSON</a></div><details id="browser-diagnostics" hidden><summary>Покрытие и вопросы</summary><pre></pre></details>`;
  document.getElementById('import-host')!.append(section);
  if(callbacks.publicDemo===false){section.querySelector<HTMLElement>('#browser-demo')!.hidden=true;const note=document.createElement('p');note.textContent='Модель сохраняется в локальной базе выбранного проекта и становится доступна MCP. Исходный файл не заменяется.';section.querySelector('h2')!.after(note);}
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>section.querySelector<T>('#'+id)!;
  const log=journalPanel(),journal=log.journal;
  el('browser-clear-cache').onclick=async()=>{let cache;try{cache=await geometryCache();await cache.clear();status('Кеш IFC очищен. При следующем открытии файл будет прочитан заново.');}catch(e){status('Кеш не очищен: '+String(e));}finally{cache?.close();}};
  el('browser-log').onclick=log.open;el('browser-document').onclick=callbacks.openDocument;
  const logButton=document.createElement('button');logButton.id='open-import-log';logButton.textContent='Журнал';logButton.onclick=log.open;
  document.getElementById('status-details')!.after(logButton);
  const base=new URL('.',location.href).href;
  let active=0,importer:Worker|null=null,planner:Worker|null=null,current:ModelPackage|null=null,fallback:ModelPackage|null=null,run:ImportRun|null=null;
  const urls=new Map<string,string>();
  let retryFiles:File[]=[],retryAppend=true;
  const skippedRuns=new WeakSet<ImportRun>();
  const processing=processingPanel(()=>el<HTMLButtonElement>('browser-cancel').click(),log.open,()=>{if(run?.state==='running'){skippedRuns.add(run);current=fallback;stop('Файл пропущен пользователем.');}},()=>void openFiles(retryFiles,retryAppend));
  const includedRuns=new WeakSet<ImportRun>();
  const coverageRuns=new WeakMap<ImportRun,CoverageItem[]>();
  let batchController:AbortController|null=null;
  let pendingFile:{run:ImportRun;resolve:(result:FileImportResult)=>void}|null=null;
  const finishRun=(target:ImportRun,state:Exclude<RunState,'running'>,message:string,details?:unknown)=>{journal.finish(target,state,message,details);if(target===run)processing.finish(state,message);if(pendingFile?.run===target){const pending=pendingFile;pendingFile=null;pending.resolve({state:skippedRuns.has(target)?'skipped':state,included:includedRuns.has(target),message,coverage:coverageRuns.get(target)});}};
  const reportProgress=(target:ImportRun,stage:string,message:string,details?:unknown)=>{journal.progress(target,stage,message,details);if(target===run)processing.update(stage,message);};
  const probe=setInterval(()=>{if(run?.state==='running'){importer?.postMessage({kind:'ping',job:active});planner?.postMessage({kind:'ping',job:active});}},2000);
  addEventListener('pagehide',()=>clearInterval(probe));

  const status=(text:string)=>{el('browser-status').textContent=text;const footer=document.getElementById('workspace-status')!;footer.textContent=text;footer.title=text;};
  const busy=(yes:boolean)=>{document.body.classList.toggle('is-busy',yes);el<HTMLButtonElement>('browser-cancel').disabled=!yes;el<HTMLButtonElement>('browser-plan').disabled=yes||!current||isNavisFormat(current.source.format);for(const id of ['open-file','empty-add-model','replace-model']){const button=document.getElementById(id) as HTMLButtonElement|null;if(button)button.disabled=yes;}};
  const stop=(reason='Обработка отменена: выбран другой файл или режим.',keepPlanner=false)=>{
    callbacks.cancelPreparation?.();
    if(run?.state==='running')finishRun(run,'cancelled',reason);
    active++;importer?.terminate();importer=null;if(!keepPlanner){planner?.terminate();planner=null;}busy(false);
  };
  const fail=(message:string,details?:unknown)=>{current=fallback;if(run)finishRun(run,'failed',message,details);stop();status(message+' · подробности в журнале');};
  const download=(id:string,data:Blob,name:string)=>{const old=urls.get(id);if(old)URL.revokeObjectURL(old);const url=URL.createObjectURL(data);urls.set(id,url);const a=el<HTMLAnchorElement>(id);a.href=url;a.download=name;a.hidden=false;};
  const diagnosticReport=(report:unknown)=>{el('browser-diagnostics').hidden=false;section.querySelector('pre')!.textContent=JSON.stringify(report,null,2);download('browser-report',new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'uvyazka-diagnostics.json');};
  el('browser-cancel').onclick=()=>{batchController?.abort();current=fallback;callbacks.cancelDrawing();stop('Отменено пользователем.');status('Обработка отменена. События сохранены в журнале.');};
  el('browser-demo').onclick=async()=>{batchController?.abort();stop('Переход к учебному примеру.');await journal.flush();location.href=base;};
  const startFile=async(file:File,appendMode:boolean|undefined,done:(result:FileImportResult)=>void,intent?:ImportIntent)=>{
    document.querySelector<HTMLDialogElement>('#file-dialog')!.close();
    stop();const job=active;await log.ready;if(job!==active){done({state:'cancelled',included:false,message:'Открытие отменено до запуска.'});return;}
    run=journal.begin('import',file.name,file.size);const jobRun=run;log.select(run);processing.begin(file.name,file.size);
    pendingFile={run:jobRun,resolve:done};
    fallback=current;
    const policy=filePolicy(file.name,file.size);
    if(policy.error){fail(policy.error);return;}
    if(policy.warning)journal.event(run,'warning',policy.warning);
    const memoryMiB=Number(el<HTMLSelectElement>('browser-memory').value);
    journal.event(run,'info','Настройки обработки',{ifc_memory_budget_mib:memoryMiB,rvt_reader_max_bytes:2*1024**3,processing:'browser-local'});
    const append=(appendMode??el<HTMLInputElement>('browser-append').checked)&&!/\.(dwg|dxf)$/i.test(file.name);
    fallback=current;busy(true);status('Чтение '+file.name);
    for(const [id,url] of urls){URL.revokeObjectURL(url);el(id).hidden=true;}urls.clear();el('browser-diagnostics').hidden=true;
    try{
      if(/\.(dwg|dxf)$/i.test(file.name)){
        reportProgress(run,'CAD','Чтение чертежа');await callbacks.drawing(file);
        if(job===active){document.querySelector<HTMLDialogElement>('#file-dialog')!.close();finishRun(jobRun,'completed','Чертёж открыт.');status(file.name+' открыт. Масштаб и слои — над чертежом.');busy(false);}return;
      }
      reportProgress(run,'Чтение файла','Загрузка байтов с локального диска');
      const buffer=await file.arrayBuffer();if(job!==active)return;
      importer=new Worker(new URL('./import.worker.ts',import.meta.url),{type:'module'});
      importer.onerror=(event)=>{if(job===active)fail(event.message?'Обработчик файла остановился: '+event.message:!jobRun.sha256?'Не удалось запустить обработчик файла. Обновите вкладку и повторите открытие: после обновления сайта старой вкладке могут быть недоступны её файлы программы.':'Обработчик файла прекратил работу без сообщения. Причина неизвестна; этап и параметры сохранены в журнале.',{filename:event.filename,line:event.lineno});};
      importer.onmessageerror=()=>{if(job===active)fail('Не удалось получить данные от worker.');};
      let stagedDocument:RvtDocument|null=null;
      importer.onmessage=async({data})=>{
        if(data.job!==active)return;processing.reply();if(data.kind==='pong')return;
        if(data.kind==='document'){
          stagedDocument=data.document;
          journal.event(jobRun,data.document.status==='partial'||data.document.schedule_data?.status==='partial'?'warning':'info',hasReadableDocument(data.document)?'Каталог видов и таблиц прочитан':'Читаемые записи каталога не получены',{cached:!!data.cached,records:data.document.records.length,status:data.document.status,error:data.document.error,clipped_records:data.document.clipped_records,schedule_parameters:data.document.schedule_data?{records:data.document.schedule_data.records.length,status:data.document.schedule_data.status,error:data.document.schedule_data.error}:undefined});
        }
        else if(data.kind==='document-cache-error'){journal.event(jobRun,'warning','Кеш каталога недоступен; прочитанные данные можно скачать JSON',{message:data.message});}
        else if(data.kind==='document-error'){
          journal.event(jobRun,'warning','Не удалось прочитать каталог RVT; геометрия обрабатывается отдельно',{message:data.message});
        }
        else if(data.kind==='nwd-units-required'){
          const unit=await chooseNwdUnits(file.name);if(job!==active)return;
          if(!unit){current=fallback;stop('Открытие NWD отменено: единицы не выбраны.');status('Открытие NWD отменено.');return;}
          importer?.postMessage({job,kind:'nwd-unit-choice',unit});
        }
        else if(data.kind==='source'){journal.source(jobRun,data.sha256);if(append&&callbacks.containsSource?.(data.sha256)){skippedRuns.add(jobRun);current=fallback;finishRun(jobRun,'completed',new SourceAlreadyPresent().message);stop();status('Повторный исходный файл пропущен.');}}
        else if(data.kind==='progress'){if(data.details?.warning)journal.event(jobRun,'warning',data.text,data.details);reportProgress(jobRun,data.stage||'Импорт',data.text,data.details);status(data.text);}
        else if(data.kind==='error'){
          diagnosticReport({filename:file.name,sha256:jobRun.sha256,outcome:'failed',message:data.message,...data.details});
          fail(importErrorMessage(data.message),{...data.details,decoder_message:data.message});
        }
        else if(data.kind==='partial'){
          diagnosticReport({filename:file.name,sha256:jobRun.sha256,outcome:'partial',message:data.message,...data.details});
          importer?.terminate();importer=null;current=fallback;let note='';
          if(stagedDocument)try{callbacks.document(stagedDocument);if(callbacks.persistDocument)await callbacks.persistDocument(stagedDocument);}catch(error){note=' Каталог не полностью сохранён: '+String(error);journal.event(jobRun,'warning','Ошибка каталога',{error:String(error)});}
          if(job!==active)return;
          if(!fallback&&!append)callbacks.noGeometry(file.name,data.message);
          const message=data.message+note;finishRun(jobRun,'partial',message,data.details);stop();status(message);
          document.querySelector<HTMLDialogElement>('#file-dialog')!.close();if(!batchController)callbacks.openDocument();
        }
        else if(data.kind==='imported'){
          importer?.terminate();importer=null;
          const s=data.model.statistics,report={source:data.model.source,statistics:s,systems:data.model.systems,diagnostics:data.model.diagnostics,conversion:data.conversion};
          journal.event(jobRun,'info','Результат извлечения',{source:data.model.source,statistics:s,cached:!!data.cached});
          if(data.model.diagnostics.length||s.geometry_errors||data.conversion?.diagnostics?.warnings?.length||data.conversion?.diagnostics?.unsupported_features?.length||data.conversion?.saved_mesh_error)
            journal.event(jobRun,'warning','Есть пропуски геометрии или предупреждения декодера. Проверьте покрытие.',report);
          el('browser-diagnostics').hidden=false;section.querySelector('pre')!.textContent=JSON.stringify(report,null,2);
          download('browser-report',new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'uvyazka-diagnostics.json');
          if(data.convertedIfc)download('browser-ifc',new Blob([data.convertedIfc],{type:'application/x-step'}),file.name.replace(/\.rvt$/i,'.ifc'));
          reportProgress(jobRun,'Отображение','Создание 3D-сцены');status('Отображение модели');
          try{const displayed=await callbacks.model(data.model,data.binary,append,intent);if(job!==active)return;current=displayed;fallback=displayed;includedRuns.add(jobRun);}
          catch(e){if(job===active){if(e instanceof SourceAlreadyPresent){skippedRuns.add(jobRun);current=fallback;finishRun(jobRun,'completed',e.message);stop();}else fail('Не удалось отобразить модель: '+String(e),{stage:'Отображение',stack:e instanceof Error?e.stack:undefined});}return;}
          if(stagedDocument)callbacks.document(stagedDocument);
          let persistenceError='';if(stagedDocument&&callbacks.persistDocument)try{await callbacks.persistDocument(stagedDocument);}catch(error){persistenceError=String(error);journal.event(jobRun,'warning','Каталог не сохранён в базу',{error:persistenceError});}if(callbacks.persist)try{await callbacks.persist(data.model,data.binary,text=>{reportProgress(jobRun,'Сохранение в проект',text);},()=>job!==active);}catch(error){persistenceError=String(error);journal.event(jobRun,'warning','Модель открыта, но не сохранена в общей базе',{error:persistenceError});}
          if(job!==active)return;
          processing.coverage(data.model);
          coverageRuns.set(jobRun,modelCoverage(data.model));
          const result=`${file.name}: ${isNavisFormat(data.model.source.format)?(data.model.nwd?.logical_nodes??0)+' узлов дерева, '+(data.model.nwd?.fragments??0)+' геометрических фрагментов':s.physical_elements+' физических элементов'}, ${s.meshes} сеток, ${s.geometry_errors} без геометрии.`+(persistenceError?' В общую базу не записано; причина — в журнале.':'');
          const partial=!!persistenceError||isNavisFormat(data.model.source.format)&&(data.model.nwd?.unread_features.length>0||data.model.nwd?.source_models.some((s:any)=>!s.geometry_complete||s.metadata_status!=='decoded_logical_subset'));
          includedRuns.add(jobRun);finishRun(jobRun,partial?'partial':'completed',result);status(result+(isNavisFormat(data.model.source.format)?' Ограничения чтения — в журнале.':' Можно рассчитать сценарий.'));busy(false);
        }
      };
      importer.postMessage({job,buffer,filename:file.name,base,memoryMiB},[buffer]);
    }catch(e){if(job===active)fail(String(e),{stack:e instanceof Error?e.stack:undefined});}
  };
  const openSingle=(file:File,appendMode?:boolean,intent?:ImportIntent)=>new Promise<FileImportResult>(resolve=>{void startFile(file,appendMode,resolve,intent).catch(error=>{const message=String(error);fail(message);resolve({state:'failed',included:false,message});});});
  const openFile=(file:File,appendMode?:boolean,intent?:ImportIntent)=>{batchController?.abort();batchController=null;processing.batch(null);return openSingle(file,appendMode,intent);};
  const openFiles=async(files:File[],appendMode?:boolean)=>{
    if(!files.length)return;
    if(files.length===1){await openFile(files[0],appendMode);return;}
    batchController?.abort();stop('Запущена новая очередь.');
    const controller=new AbortController();batchController=controller;const append=appendMode??el<HTMLInputElement>('browser-append').checked;
    const result=await importBatch(files,openSingle,{append,signal:controller.signal,update:snapshot=>{if(batchController===controller)processing.batch(snapshot);}});
    if(batchController===controller){retryFiles=files.filter((_,index)=>result.rows[index].state==='failed');retryAppend=append||result.rows.some(row=>row.included);}
    const batchRun=journal.begin('import','Пакет файлов',files.reduce((n,file)=>n+file.size,0));
    journal.finish(batchRun,result.cancelled?'cancelled':result.rows.every(row=>row.included&&row.state==='completed')?'completed':result.rows.some(row=>row.included)?'partial':'failed',batchSummary(result),result);
    if(batchController===controller){status(batchSummary(result));batchController=null;busy(false);}
  };
  el<HTMLInputElement>('browser-file').onchange=()=>{const input=el<HTMLInputElement>('browser-file'),files=Array.from(input.files??[]);input.value='';void openFiles(files);};
  const folderLabel=document.createElement('label');folderLabel.textContent='Папка моделей';const folder=document.createElement('input');folder.type='file';folder.id='browser-folder';folder.multiple=true;folder.setAttribute('webkitdirectory','');folderLabel.append(folder);el('browser-file').parentElement!.after(folderLabel);
  folder.onchange=()=>{const files=Array.from(folder.files??[]).filter(file=>/\.(nwc|nwd|ifc|rvt)$/i.test(file.name)).map(file=>new File([file],file.webkitRelativePath||file.name,{type:file.type,lastModified:file.lastModified}));folder.value='';if(files.length)void openFiles(files);else status('В папке не найдены NWC, NWD, IFC или RVT.');};
  el('browser-plan').onclick=async()=>{
    if(!current)return;
    if(current.elements.some(e=>e.semantic_kind==='geometry_fragment')){status('Сценарий для геометрических фрагментов NWD не рассчитывается: семантика объектов не прочитана.');return;}
    const curingDays=Number(el<HTMLInputElement>('browser-curing').value);if(!Number.isInteger(curingDays)||curingDays<1||curingDays>365){status('Выдержка бетона: целое число от 1 до 365 суток');return;}
    await log.ready;stop('Запущен новый расчёт.',true);const job=active;fallback=current;
    run=journal.begin('simulation',current.source.filename,current.source.size_bytes);const jobRun=run;log.select(run);journal.source(run,current.source.sha256);document.querySelector<HTMLDialogElement>('#file-dialog')!.close();processing.begin(current.source.filename,current.source.size_bytes,true);
    busy(true);status('Подготовка расчёта');processing.update('Подготовка','Загрузка расчётного движка');
    planner??=new Worker(new URL('./planner.worker.ts',import.meta.url),{type:'module'});
    planner.onerror=(event)=>{if(job===active)fail('Ошибка расчёта: '+event.message);};
    planner.onmessage=async({data})=>{
      if(data.job!==active)return;processing.reply();if(data.kind==='pong')return;
      if(data.kind==='progress'){reportProgress(jobRun,/Загрузка Python/.test(data.text)?'Подготовка':'Расчёт',data.text);status(data.text);}
      else if(data.kind==='error')fail('Не удалось рассчитать: '+data.message);
      else if(data.kind==='planned'){
        try{reportProgress(jobRun,'Отображение','Подготовка результата расчёта');await callbacks.run(data.run);if(job!==active)return;const message=`Рассчитано: ${data.run.scenario.operations.length} работ, ${data.run.duration} минут. Вне графика: ${data.run.scenario.unplanned_element_ids.length} элементов.`;
          if(data.run.scenario.unplanned_element_ids.length)journal.event(jobRun,'warning','Часть элементов осталась вне графика',{element_ids:data.run.scenario.unplanned_element_ids});
          finishRun(jobRun,'completed',message);status(message);
        }catch(e){if(job===active)fail(String(e));}if(job===active)busy(false);
      }
    };
    const settings={variant:el<HTMLSelectElement>('browser-variant').value,curingDays,capacityFactor:Number(el<HTMLSelectElement>('browser-capacity').value)};
    journal.event(run,'info','Параметры расчёта',settings);planner.postMessage({job,base,model:current,...settings});
  };
  document.addEventListener('scene-model-changed',((event:CustomEvent<ModelPackage|null>)=>{batchController?.abort();stop('Изменён состав или размещение сцены.');current=event.detail;busy(false);}) as EventListener);
  addEventListener('pagehide',()=>{if(run?.state==='running')finishRun(run,'interrupted','Вкладка закрыта или перезагружена до завершения.');stop();for(const url of urls.values())URL.revokeObjectURL(url);});
  return {openFile,openFiles,sceneProgress:(text:string)=>{if(run?.state==='running')reportProgress(run,'Отображение',text);},stop:(reason?:string)=>{batchController?.abort();stop(reason);}};
}
