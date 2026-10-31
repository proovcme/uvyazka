import type {ModelPackage} from './model';
import type {SceneIfcOptions,SceneIfcReport} from './scene-ifc';
export function sceneIfcTask(model:ModelPackage,binary:ArrayBuffer,options:SceneIfcOptions,signal:AbortSignal,progress:(message:string)=>void):Promise<{chunks:Uint8Array[];report:SceneIfcReport}>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(new DOMException('Экспорт отменён','AbortError'));return;}
  const worker=new Worker(new URL('./scene-ifc.worker.ts',import.meta.url),{type:'module'});let done=false;
  const finish=(error?:unknown,result?:any)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(result);};
  const abort=()=>finish(new DOMException('Экспорт отменён','AbortError'));signal.addEventListener('abort',abort,{once:true});
  worker.onmessage=({data})=>{if(done)return;if(typeof data.progress==='string'){try{progress(data.progress);}catch{}return;}if(data.error)finish(Error(data.error));else finish(undefined,data);};
  worker.onerror=event=>finish(Error(event.message||'Не удалось сформировать IFC.'));
  worker.onmessageerror=()=>finish(Error('Не удалось получить файл IFC.'));
  const {progress:observer,...serializable}=options;
  try{worker.postMessage({model,binary,options:serializable,base:new URL(import.meta.env.BASE_URL,location.href).href});}catch(error){finish(error);}
 });
}
