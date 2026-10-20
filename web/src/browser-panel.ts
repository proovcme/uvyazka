import type { ModelPackage } from './model';
import type { RunPackage } from './simulation';
import { journalPanel } from './import-journal-panel';
import { filePolicy } from './import-journal';
import type { ImportRun } from './import-journal';

export type BrowserRun=RunPackage & {cpm:{duration_minutes:number;operations:Record<string,{critical:boolean}>}};
export function browserPanel(callbacks:{reset:()=>void;drawing:(file:File)=>Promise<void>;cancelDrawing:()=>void;model:(model:ModelPackage,binary:ArrayBuffer)=>void|Promise<void>;run:(run:BrowserRun)=>void|Promise<void>}) {
  const section=document.createElement('section');section.className='panel browser-import';section.innerHTML=`
<h2>Открыть файл</h2>
<p>Файл остаётся на вашем устройстве. Для RVT и IFC прежний порог размера снят; большие модели требуют больше памяти. DWG/DXF до 64 MiB. Чтение RVT экспериментальное; Revit и агент не нужны.</p>
<div class="browser-actions"><label>DWG / RVT / IFC<input id="browser-file" type="file" accept=".dwg,.dxf,.rvt,.ifc"></label><button id="browser-cancel" disabled>Отменить</button><button id="browser-demo">Учебный пример</button><button id="browser-log">Журнал обработки</button></div>
<p id="browser-status" role="status" aria-live="polite">Выберите файл или изучите готовый пример ниже.</p>
<details><summary>Память и большие модели</summary><label>Бюджет IFC-декодера<select id="browser-memory"><option value="512">512 MiB</option><option value="1024" selected>1 GiB</option><option value="2048">2 GiB</option></select></label><p>Это бюджет IFC-движка, а не всей вкладки. RVT, промежуточный IFC и 3D требуют дополнительной памяти. Технический предел RVT-читателя — 2 GiB входного файла; успешное чтение такого размера не гарантируется.</p></details>
<div class="browser-actions simulation-only"><label>Ресурсы<select id="browser-variant"><option value="base">Базовые</option><option value="reinforced">Усиленные</option></select></label><label>Доступность ресурсов<select id="browser-capacity"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label><label>Выдержка бетона, суток<input id="browser-curing" type="number" min="1" max="365" value="28"></label><button id="browser-plan" disabled>Рассчитать сценарий</button></div>
<p class="simulation-only">Работы, технология, выработка и связи — предварительные допущения IFCCS. Стадии RVT в браузере пока не читаются; существующие и демонтируемые элементы автоматически не исключаются.</p>
<div class="browser-actions"><a id="browser-ifc" hidden>Скачать IFC</a><a id="browser-report" hidden>Диагностика JSON</a></div><details id="browser-diagnostics" hidden><summary>Покрытие и вопросы</summary><pre></pre></details>`;
  document.getElementById('import-host')!.append(section);
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>section.querySelector<T>('#'+id)!;
  const log=journalPanel(),journal=log.journal;
  el('browser-log').onclick=log.open;
  const logButton=document.createElement('button');logButton.id='open-import-log';logButton.textContent='Журнал';logButton.onclick=log.open;
  document.getElementById('status-details')!.after(logButton);
  const base=new URL('.',location.href).href;
  let active=0,importer:Worker|null=null,planner:Worker|null=null,current:ModelPackage|null=null,run:ImportRun|null=null;
  const urls=new Map<string,string>();
  const status=(text:string)=>{el('browser-status').textContent=text;const footer=document.getElementById('workspace-status')!;footer.textContent=text;footer.title=text;};
  const busy=(yes:boolean)=>{document.body.classList.toggle('is-busy',yes);el<HTMLButtonElement>('browser-cancel').disabled=!yes;el<HTMLButtonElement>('browser-plan').disabled=yes||!current;};
  const stop=(reason='Обработка отменена: выбран другой файл или режим.')=>{
    if(run?.state==='running')journal.finish(run,'cancelled',reason);
    active++;importer?.terminate();planner?.terminate();importer=planner=null;busy(false);
  };
  const fail=(message:string,details?:unknown)=>{if(run)journal.finish(run,'failed',message,details);stop();status(message+' · подробности в журнале');};
  const download=(id:string,data:Blob,name:string)=>{const old=urls.get(id);if(old)URL.revokeObjectURL(old);const url=URL.createObjectURL(data);urls.set(id,url);const a=el<HTMLAnchorElement>(id);a.href=url;a.download=name;a.hidden=false;};
  el('browser-cancel').onclick=()=>{callbacks.cancelDrawing();stop('Отменено пользователем.');status('Обработка отменена. События сохранены в журнале.');};
  el('browser-demo').onclick=async()=>{stop('Переход к учебному примеру.');await journal.flush();location.href=base;};
  el<HTMLInputElement>('browser-file').onchange=async()=>{
    const input=el<HTMLInputElement>('browser-file'),file=input.files?.[0];if(!file)return;input.value='';
    document.querySelector<HTMLDialogElement>('#file-dialog')!.showModal();
    stop();const job=active;await log.ready;if(job!==active)return;
    run=journal.begin('import',file.name,file.size);const jobRun=run;log.select(run);
    const policy=filePolicy(file.name,file.size);
    if(policy.error){fail(policy.error);return;}
    if(policy.warning)journal.event(run,'warning',policy.warning);
    const memoryMiB=Number(el<HTMLSelectElement>('browser-memory').value);
    journal.event(run,'info','Настройки обработки',{ifc_memory_budget_mib:memoryMiB,rvt_reader_max_bytes:2*1024**3,processing:'browser-local'});
    current=null;callbacks.reset();busy(true);status('Чтение '+file.name);
    for(const [id,url] of urls){URL.revokeObjectURL(url);el(id).hidden=true;}urls.clear();el('browser-diagnostics').hidden=true;
    try{
      if(/\.(dwg|dxf)$/i.test(file.name)){
        journal.progress(run,'CAD','Чтение чертежа');await callbacks.drawing(file);
        if(job===active){journal.finish(jobRun,'completed','Чертёж открыт.');status(file.name+' открыт. Масштаб и слои — над чертежом.');busy(false);}return;
      }
      journal.progress(run,'Чтение файла','Загрузка байтов с локального диска');
      const buffer=await file.arrayBuffer();if(job!==active)return;
      importer=new Worker(new URL('./import.worker.ts',import.meta.url),{type:'module'});
      importer.onerror=(event)=>{if(job===active)fail('Worker остановился: '+(event.message||'причина недоступна; возможна нехватка памяти'),{filename:event.filename,line:event.lineno});};
      importer.onmessageerror=()=>{if(job===active)fail('Не удалось получить данные от worker.');};
      importer.onmessage=async({data})=>{
        if(data.job!==active)return;
        if(data.kind==='source')journal.source(jobRun,data.sha256);
        else if(data.kind==='progress'){journal.progress(jobRun,data.stage||'Импорт',data.text,data.details);status(data.text);}
        else if(data.kind==='error')fail('Не удалось открыть: '+data.message,data.details);
        else if(data.kind==='imported'){
          importer?.terminate();importer=null;
          const s=data.model.statistics,report={source:data.model.source,statistics:s,systems:data.model.systems,diagnostics:data.model.diagnostics,conversion:data.conversion};
          journal.event(jobRun,'info','Результат извлечения',{source:data.model.source,statistics:s});
          if(data.model.diagnostics.length||s.geometry_errors||data.conversion?.diagnostics?.warnings?.length||data.conversion?.diagnostics?.unsupported_features?.length||data.conversion?.saved_mesh_error)
            journal.event(jobRun,'warning','Есть пропуски геометрии или предупреждения декодера. Проверьте покрытие.',report);
          el('browser-diagnostics').hidden=false;section.querySelector('pre')!.textContent=JSON.stringify(report,null,2);
          download('browser-report',new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'uvyazka-diagnostics.json');
          if(data.convertedIfc)download('browser-ifc',new Blob([data.convertedIfc],{type:'application/x-step'}),file.name.replace(/\.rvt$/i,'.ifc'));
          journal.progress(jobRun,'Отображение','Создание 3D-сцены');status('Отображение модели');
          try{await callbacks.model(data.model,data.binary);if(job!==active)return;current=data.model;}
          catch(e){if(job===active)fail('Не удалось отобразить модель: '+String(e));return;}
          const result=`${file.name}: ${s.physical_elements} физических элементов, ${s.meshes} сеток, ${s.geometry_errors} без геометрии.`;
          journal.finish(jobRun,'completed',result);status(result+' Можно рассчитать сценарий.');busy(false);
        }
      };
      importer.postMessage({job,buffer,filename:file.name,base,memoryMiB},[buffer]);
    }catch(e){if(job===active)fail(String(e),{stack:e instanceof Error?e.stack:undefined});}
  };
  el('browser-plan').onclick=async()=>{
    if(!current)return;
    const curingDays=Number(el<HTMLInputElement>('browser-curing').value);if(!Number.isInteger(curingDays)||curingDays<1||curingDays>365){status('Выдержка бетона: целое число от 1 до 365 суток');return;}
    await log.ready;stop('Запущен новый расчёт.');const job=active;
    run=journal.begin('simulation',current.source.filename,current.source.size_bytes);const jobRun=run;log.select(run);journal.source(run,current.source.sha256);
    busy(true);status('Подготовка расчёта');
    planner=new Worker(new URL('./planner.worker.ts',import.meta.url),{type:'module'});
    planner.onerror=(event)=>{if(job===active)fail('Ошибка расчёта: '+event.message);};
    planner.onmessage=async({data})=>{
      if(data.job!==active)return;
      if(data.kind==='progress'){journal.progress(jobRun,'Расчёт',data.text);status(data.text);}
      else if(data.kind==='error')fail('Не удалось рассчитать: '+data.message);
      else if(data.kind==='planned'){
        try{await callbacks.run(data.run);if(job!==active)return;const message=`Рассчитано: ${data.run.scenario.operations.length} работ, ${data.run.duration} минут. Вне графика: ${data.run.scenario.unplanned_element_ids.length} элементов.`;
          if(data.run.scenario.unplanned_element_ids.length)journal.event(jobRun,'warning','Часть элементов осталась вне графика',{element_ids:data.run.scenario.unplanned_element_ids});
          journal.finish(jobRun,'completed',message);status(message);
        }catch(e){if(job===active)fail(String(e));}if(job===active){planner?.terminate();planner=null;busy(false);}
      }
    };
    const settings={variant:el<HTMLSelectElement>('browser-variant').value,curingDays,capacityFactor:Number(el<HTMLSelectElement>('browser-capacity').value)};
    journal.event(run,'info','Параметры расчёта',settings);planner.postMessage({job,base,model:current,...settings});
  };
  addEventListener('pagehide',()=>{if(run?.state==='running')journal.finish(run,'interrupted','Вкладка закрыта или перезагружена до завершения.');stop();for(const url of urls.values())URL.revokeObjectURL(url);});
}
