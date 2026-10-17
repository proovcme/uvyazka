import type { ModelPackage } from './model';
import type { RunPackage } from './simulation';

export type BrowserRun=RunPackage & {cpm:{duration_minutes:number;operations:Record<string,{critical:boolean}>}};
export function browserPanel(callbacks:{reset:()=>void;drawing:(file:File)=>Promise<void>;cancelDrawing:()=>void;model:(model:ModelPackage,binary:ArrayBuffer)=>void;run:(run:BrowserRun)=>void}) {
  const section=document.createElement('section');section.className='panel browser-import';section.innerHTML=`
<h2>Открыть файл</h2>
<p>Файл остаётся на вашем устройстве. IFC до 128 MiB; RVT, DWG и DXF до 64 MiB. Чтение RVT экспериментальное; Revit и агент не нужны.</p>
<div class="browser-actions"><label>DWG / RVT / IFC<input id="browser-file" type="file" accept=".dwg,.dxf,.rvt,.ifc"></label><button id="browser-cancel" disabled>Отменить</button><button id="browser-demo">Учебный пример</button></div>
<p id="browser-status" role="status" aria-live="polite">Выберите файл или изучите готовый пример ниже.</p>
<div class="browser-actions simulation-only"><label>Ресурсы<select id="browser-variant"><option value="base">Базовые</option><option value="reinforced">Усиленные</option></select></label><label>Доступность ресурсов<select id="browser-capacity"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label><label>Выдержка бетона, суток<input id="browser-curing" type="number" min="1" max="365" value="28"></label><button id="browser-plan" disabled>Рассчитать сценарий</button></div>
<p class="simulation-only">Работы, технология, выработка и связи — предварительные допущения IFCCS. Стадии RVT в браузере пока не читаются; существующие и демонтируемые элементы автоматически не исключаются.</p>
<div class="browser-actions"><a id="browser-ifc" hidden>Скачать IFC</a><a id="browser-report" hidden>Диагностика JSON</a></div><details id="browser-diagnostics" hidden><summary>Покрытие и вопросы</summary><pre></pre></details>`;
  document.querySelector('.notice')!.after(section);
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>section.querySelector<T>('#'+id)!;
  const base=new URL('.',location.href).href;
  let active=0,importer:Worker|null=null,planner:Worker|null=null,current:ModelPackage|null=null;
  const urls=new Map<string,string>();
  const status=(text:string)=>el('browser-status').textContent=text;
  const busy=(yes:boolean)=>{el<HTMLButtonElement>('browser-cancel').disabled=!yes;el<HTMLButtonElement>('browser-plan').disabled=yes||!current;};
  const stop=()=>{active++;importer?.terminate();planner?.terminate();importer=planner=null;busy(false);};
  const download=(id:string,data:Blob,name:string)=>{const old=urls.get(id);if(old)URL.revokeObjectURL(old);const url=URL.createObjectURL(data);urls.set(id,url);const a=el<HTMLAnchorElement>(id);a.href=url;a.download=name;a.hidden=false;};
  el('browser-cancel').onclick=()=>{callbacks.cancelDrawing();stop();status('Отменено. Последний готовый результат сохранён в текущей вкладке.');};
  el('browser-demo').onclick=()=>{stop();location.href=base;};
  el<HTMLInputElement>('browser-file').onchange=async()=>{
    const file=el<HTMLInputElement>('browser-file').files?.[0];if(!file)return;
    stop();const job=active;
    if(!/\.(ifc|rvt|dwg|dxf)$/i.test(file.name)||!file.size||file.size>(/\.ifc$/i.test(file.name)?128:64)*1024*1024){status('Нужен IFC до 128 MiB либо DWG, DXF, RVT до 64 MiB');return;}
    current=null;callbacks.reset();busy(true);status('Чтение '+file.name);
    for(const [id,url] of urls){URL.revokeObjectURL(url);el(id).hidden=true;}urls.clear();el('browser-diagnostics').hidden=true;
    try{
      if(/\.(dwg|dxf)$/i.test(file.name)){await callbacks.drawing(file);if(job===active){status(file.name+' открыт. Масштаб и слои — над чертежом. Для строительной симуляции нужна BIM-модель.');busy(false);}return;}
      const buffer=await file.arrayBuffer();if(job!==active)return;
      importer=new Worker(new URL('./import.worker.ts',import.meta.url),{type:'module'});
      importer.onerror=(event)=>{if(job===active){stop();status('Ошибка worker: '+event.message);}};
      importer.onmessage=({data})=>{
        if(data.job!==active)return;
        if(data.kind==='progress')status(data.text);
        else if(data.kind==='error'){stop();status('Не удалось открыть: '+data.message);}
        else if(data.kind==='imported'){
          importer?.terminate();importer=null;current=data.model;
          try{callbacks.model(data.model,data.binary);}catch(e){status(String(e));busy(false);return;}
          const s=data.model.statistics,report={source:data.model.source,statistics:s,systems:data.model.systems,diagnostics:data.model.diagnostics,conversion:data.conversion,geometry: data.model.elements.filter((e:any)=>e.geometry_evidence).map((e:any)=>({id:e.id,...e.geometry_evidence}))};
          el('browser-diagnostics').hidden=false;section.querySelector('pre')!.textContent=JSON.stringify(report,null,2);
          download('browser-report',new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'uvyazka-diagnostics.json');
          if(data.convertedIfc)download('browser-ifc',new Blob([data.convertedIfc],{type:'application/x-step'}),file.name.replace(/\.rvt$/i,'.ifc'));
          status(`${file.name}: ${s.physical_elements} физических элементов, ${s.meshes} сеток, ${s.geometry_errors} без геометрии. Можно рассчитать сценарий.`);busy(false);
        }
      };
      importer.postMessage({job,buffer,filename:file.name,base},[buffer]);
    }catch(e){if(job===active){stop();status(String(e));}}
  };
  el('browser-plan').onclick=()=>{
    if(!current)return;
    const curingDays=Number(el<HTMLInputElement>('browser-curing').value);if(!Number.isInteger(curingDays)||curingDays<1||curingDays>365){status('Выдержка бетона: целое число от 1 до 365 суток');return;}
    const job=++active;busy(true);status('Подготовка расчёта');
    planner??=new Worker(new URL('./planner.worker.ts',import.meta.url),{type:'module'});
    planner.onerror=(event)=>{if(job===active){stop();status('Ошибка расчёта: '+event.message);}};
    planner.onmessage=({data})=>{if(data.job!==active)return;if(data.kind==='progress')status(data.text);else if(data.kind==='error'){stop();status('Не удалось рассчитать: '+data.message);}else if(data.kind==='planned'){try{callbacks.run(data.run);status(`Рассчитано: ${data.run.scenario.operations.length} работ, ${data.run.duration} минут. Вне графика: ${data.run.scenario.unplanned_element_ids.length} элементов.`);}catch(e){status(String(e));}busy(false);}};
    planner.postMessage({job,base,model:current,variant:el<HTMLSelectElement>('browser-variant').value,curingDays,capacityFactor:Number(el<HTMLSelectElement>('browser-capacity').value)});
  };
  addEventListener('pagehide',()=>{stop();for(const url of urls.values())URL.revokeObjectURL(url);});
}
