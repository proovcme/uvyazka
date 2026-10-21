import { importIfc } from './browser-ifc';
import {documentCache} from './rvt-document-cache';
import {rvtImportFailure} from './rvt-import-result';
import type {RvtDocument} from './rvt-document';

const worker=self as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage:(value:unknown,transfer?:Transferable[])=>void};
worker.onmessage=async({data})=>{
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
          const cached=!!document;
          if(!document)document=module.extractRvtDocument(bytes);
          if(!cached&&document.records.some((r:any)=>r.kind==='schedule')){
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
          if(!cached&&document.status!=='partial'&&document.schedule_data?.status!=='partial')try {await cache?.put(sourceHash,document);}catch(error){worker.postMessage({job,kind:'document-cache-error',message:String(error)});}
        }finally{cache?.close();}
      } catch(error) {
        worker.postMessage({job,kind:'document-error',message:String(error)});
      }
      progress('Конверсия RVT и чтение сохранённых сеток','RVT → IFC');
      conversion=module.convertRvtBytes(bytes);
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
    if(conversion){model.model_id=sourceHash;model.source={...model.source,format:'rvt',sha256:sourceHash,size_bytes:sourceSize,conversion:{engine:'rvt-rs',local_patches:['uvyazka-native-mep-v1','uvyazka-wasm-field-bounds-v1'],warnings:conversion.diagnostics.warnings,unsupported_features:conversion.diagnostics.unsupported_features,ifc_sha256:model.source.sha256,confidence:conversion.diagnostics.confidence,source_revision:'120e2f9ffa8422ba437102c8d300b7e902cdde80'}};}
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
