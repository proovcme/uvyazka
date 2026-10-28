import {attachNativeEngineering} from './native-engineering';
import {importNwd,nwdNeedsUnits} from './browser-nwd';
import {geometryCache} from './geometry-cache';
import { importIfc } from './browser-ifc';
import {documentCache} from './rvt-document-cache';
import {rvtImportFailure} from './rvt-import-result';
import type {RvtDocument} from './rvt-document';

const worker=self as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage:(value:unknown,transfer?:Transferable[])=>void};
let unitReply:{job:unknown;resolve:(unit:any)=>void}|null=null;
worker.onmessage=async({data})=>{
  if(data.kind==='ping'){worker.postMessage({job:data.job,kind:'pong'});return;}
  if(data.kind==='nwd-unit-choice'){if(unitReply&&unitReply.job===data.job){unitReply.resolve(data.unit);unitReply=null;}return;}
  const {job,buffer,filename,base,memoryMiB=1024}=data;
  let stage='Проверка файла',conversion:any=null,rvtDocument:RvtDocument|null=null;
  const progress=(text:string,nextStage=stage,details?:unknown)=>{stage=nextStage;worker.postMessage({job,kind:'progress',stage,text,details});};
  try {
    if(![512,1024,2048].includes(memoryMiB))throw Error('Недопустимый бюджет памяти IFC-декодера');
    let bytes=new Uint8Array(buffer),convertedIfc:ArrayBuffer|null=null;
    const digest=async(b:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b as Uint8Array<ArrayBuffer>)),n=>n.toString(16).padStart(2,'0')).join('');
    progress('Вычисление SHA-256 исходного файла','Хеширование');
    const sourceHash=await digest(bytes),sourceSize=bytes.byteLength;
    worker.postMessage({job,kind:'source',sha256:sourceHash});
    if(/\.nwd$/i.test(filename)){
      progress('Загрузка независимого NWD-декодера','NWD-движок');
      const module=await import(/* @vite-ignore */base+'runtime/nwd/uvyazka_nwd_experiment.js');
      await module.default({module_or_path:base+'runtime/nwd/uvyazka_nwd_experiment_bg.wasm'});
      let result=module.inspectNwdBytes(bytes,(text:string)=>progress(text,'Данные NWD'));
      let unit=data.nwdUnit;
      if(nwdNeedsUnits(result)&&!unit){
        progress('Единицы некоторых источников не прочитаны; требуется уточнение','Ожидание единиц');
        unit=await new Promise(resolve=>{unitReply={job,resolve};worker.postMessage({job,kind:'nwd-units-required'});});
      }
      progress('Подготовка дерева, свойств и геометрии в метрах','Геометрия');
      const {model,binary}=await importNwd(result,filename,unit);
      result=null;bytes=new Uint8Array();
      await new Promise(resolve=>setTimeout(resolve,0));
      worker.postMessage({job,kind:'imported',model,binary},[binary]);return;
    }
    if(/\.ifc$/i.test(filename)){
      let cache;
      try{cache=await geometryCache();const cached=await cache.get(sourceHash);if(cached){
        cached.model.source.filename=filename;
        progress('Геометрия и свойства восстановлены из локального кеша','Кеш IFC');
        worker.postMessage({job,kind:'imported',model:cached.model,binary:cached.binary,cached:true},[cached.binary]);return;
      }}catch(error){progress('Кеш IFC недоступен; читаем исходный файл','Кеш IFC',{warning:String(error)});}finally{cache?.close();}
    }
    if(/\.rvt$/i.test(filename)){
      progress('Загрузка RVT-декодера · файл остаётся в браузере','RVT-движок');
      const module=await import(/* @vite-ignore */base+'runtime/rvt/uvyazka_rvt_browser.js');
      await module.default({module_or_path:base+'runtime/rvt/uvyazka_rvt_browser_bg.wasm'});
      progress('Чтение видов, листов и спецификаций RVT','Документ RVT');
      try {
        let cache:Awaited<ReturnType<typeof documentCache>>|undefined;
        try {cache=await documentCache();}catch(error){worker.postMessage({job,kind:'document-cache-error',message:String(error)});}
        try {
          let document;try {document=await cache?.get(sourceHash);}catch(error){worker.postMessage({job,kind:'document-cache-error',message:String(error)});}
          const cached=!!document;let parametersUpdated=false;
          if(!document)document=module.extractRvtDocument(bytes);
          if(!document.schedule_data){parametersUpdated=true;
            // Keep the catalogue even if parameter extraction fails.
            document.source={filename,sha256:sourceHash,size_bytes:sourceSize};
            rvtDocument=document;worker.postMessage({job,kind:'document',document,cached:false});
            progress('Чтение параметров экземпляров и типов RVT','Параметры RVT');
            try {document.schedule_data=module.extractRvtScheduleData(bytes);document.schedule_data.source_sha256=sourceHash;}
            catch(error){document.schedule_data={status:'partial',records:[],scope:['FamilyInstance','FamilySymbol'],error:String(error),source_sha256:sourceHash};}
          }
          document.source={filename,sha256:sourceHash,size_bytes:sourceSize};
          // Publish before saving: a quota error must not discard usable data.
          rvtDocument=document;worker.postMessage({job,kind:'document',document,cached});
          if((!cached||parametersUpdated)&&document.status!=='partial'&&document.schedule_data?.status!=='partial')try {await cache?.put(sourceHash,document);}catch(error){worker.postMessage({job,kind:'document-cache-error',message:String(error)});}
        }finally{cache?.close();}
      } catch(error) {
        worker.postMessage({job,kind:'document-error',message:String(error)});
      }
      let engineering;
      if(module.extractRvtEngineering){progress('Чтение систем и базового оборудования цепей','Связи RVT');try{engineering=module.extractRvtEngineering(bytes);}catch(error){engineering={status:'partial',systems:[],diagnostics:[String(error)]};}}
      progress('Конверсия RVT и чтение сохранённых сеток','RVT → IFC');
      conversion=module.convertRvtBytes(bytes);conversion.engineering=engineering;
      if(!conversion.ifc_step)throw Error(conversion.quality_error||'RVT: пригодная геометрия не получена');
      progress('Подготовка промежуточного IFC','IFC-буфер');
      bytes=new TextEncoder().encode(conversion.ifc_step);convertedIfc=bytes.buffer as ArrayBuffer;delete conversion.ifc_step;
    }else if(!/\.ifc$/i.test(filename))throw Error('Выберите IFC или RVT');
    progress('Загрузка IFC-движка','IFC-движок',{memory_budget_mib:memoryMiB});
    const {IfcAPI}=await import(/* @vite-ignore */base+'runtime/web-ifc/web-ifc-api.js');
    const api=new IfcAPI();api.SetWasmPath(base+'runtime/web-ifc/',true);await api.Init(undefined,true);
    const response=await fetch(base+'runtime/ifc-hierarchy.json');if(!response.ok)throw Error('Не загружена схема IFC');
    progress('Чтение структуры IFC','Структура IFC');
    const {model,binary}=await importIfc(api,bytes,filename,await digest(bytes),await response.json(),
      text=>progress(text,text.startsWith('Геометрия:')?'Геометрия':'Свойства IFC'),!!conversion,memoryMiB);
    if(conversion){model.model_id=sourceHash;model.source={...model.source,format:'rvt',sha256:sourceHash,size_bytes:sourceSize,conversion:{engine:'rvt-rs',local_patches:['uvyazka-native-mep-v1','uvyazka-wasm-field-bounds-v1','uvyazka-native-2021-v1'],warnings:conversion.diagnostics.warnings,unsupported_features:conversion.diagnostics.unsupported_features,ifc_sha256:model.source.sha256,confidence:conversion.diagnostics.confidence,source_revision:'b6086d41b9758fd9b92f42f0a47b8345b9c58056'}};}
    if(conversion?.engineering)attachNativeEngineering(model,conversion.engineering,sourceHash);
    if(!conversion){let cache;try{cache=await geometryCache();await cache.put(sourceHash,model,binary);}catch(error){progress('Модель прочитана; кеш не сохранён','Кеш IFC',{warning:String(error)});}finally{cache?.close();}}
    worker.postMessage({job,kind:'imported',model,binary,conversion,convertedIfc},[binary,...(convertedIfc?[convertedIfc]:[])]);
  } catch(error) {
    if(conversion)delete conversion.ifc_step;
    const message=error instanceof Error?error.message:String(error);
    if(/\.rvt$/i.test(filename)){
      const result=rvtImportFailure(message,rvtDocument,conversion);
      worker.postMessage({job,...result,details:{...result.details,stage,stack:error instanceof Error?error.stack:undefined,memory_budget_mib:memoryMiB}});return;
    }
    worker.postMessage({job,kind:'error',message,
      details:{stage,stack:error instanceof Error?error.stack:undefined,conversion,memory_budget_mib:memoryMiB}});
  }
};
