import { importIfc } from './browser-ifc';

const worker=self as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage:(value:unknown,transfer?:Transferable[])=>void};
worker.onmessage=async({data})=>{
  const {job,buffer,filename,base}=data;
  const progress=(text:string)=>worker.postMessage({job,kind:'progress',text});
  try {
    let bytes=new Uint8Array(buffer),conversion:any=null,convertedIfc:ArrayBuffer|null=null;
    const digest=async(b:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b as Uint8Array<ArrayBuffer>)),n=>n.toString(16).padStart(2,'0')).join('');
    const sourceHash=await digest(bytes),sourceSize=bytes.byteLength;
    if(/\.rvt$/i.test(filename)){
      if(sourceSize>64*1024*1024)throw Error('RVT превышает предел 64 MiB. Используйте локальный инструмент.');
      progress('Загрузка RVT-декодера · файл остаётся в браузере');
      const module=await import(/* @vite-ignore */base+'runtime/rvt/uvyazka_rvt_browser.js');
      await module.default({module_or_path:base+'runtime/rvt/uvyazka_rvt_browser_bg.wasm'});
      progress('Конверсия RVT и чтение сохранённых сеток');
      conversion=module.convertRvtBytes(bytes);
      if(!conversion.ifc_step)throw Error(conversion.quality_error||'RVT: пригодная геометрия не получена');
      bytes=new TextEncoder().encode(conversion.ifc_step);convertedIfc=bytes.buffer as ArrayBuffer;delete conversion.ifc_step;
    }else if(!/\.ifc$/i.test(filename))throw Error('Выберите IFC или RVT');
    progress('Загрузка IFC-движка');
    const {IfcAPI}=await import(/* @vite-ignore */base+'runtime/web-ifc/web-ifc-api.js');
    const api=new IfcAPI();api.SetWasmPath(base+'runtime/web-ifc/',true);await api.Init(undefined,true);
    const response=await fetch(base+'runtime/ifc-hierarchy.json');if(!response.ok)throw Error('Не загружена схема IFC');
    const {model,binary}=await importIfc(api,bytes,filename,await digest(bytes),await response.json(),progress,!!conversion);
    if(conversion){model.model_id=sourceHash;model.source={...model.source,format:'rvt',sha256:sourceHash,size_bytes:sourceSize,conversion:{engine:'rvt-rs/uvyazka-native-mep-v1',warnings:conversion.diagnostics.warnings,unsupported_features:conversion.diagnostics.unsupported_features,ifc_sha256:model.source.sha256,confidence:conversion.diagnostics.confidence,source_revision:'120e2f9ffa8422ba437102c8d300b7e902cdde80'}};}
    worker.postMessage({job,kind:'imported',model,binary,conversion,convertedIfc},[binary,...(convertedIfc?[convertedIfc]:[])]);
  } catch(error) {worker.postMessage({job,kind:'error',message:error instanceof Error?error.message:String(error)});}
};
