import type {SavedScene} from './viewer-workspace';
export interface ArchiveOptions {signal?:AbortSignal;progress?:(message:string)=>void}
export function archiveTask(kind:'pack',value:SavedScene,options?:ArchiveOptions):Promise<Uint8Array>;
export function archiveTask(kind:'unpack',value:ArrayBuffer,options?:ArchiveOptions):Promise<SavedScene>;
export function archiveTask(kind:'pack'|'unpack',value:SavedScene|ArrayBuffer,options:ArchiveOptions={}):Promise<any>{return new Promise((resolve,reject)=>{
 if(options.signal?.aborted){reject(new DOMException('Операция отменена','AbortError'));return;}
 const worker=new Worker(new URL('./workspace-archive.worker.ts',import.meta.url),{type:'module'});
 let settled=false;const finish=(error?:unknown,result?:unknown)=>{if(settled)return;settled=true;options.signal?.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(result);};
 const abort=()=>finish(new DOMException('Операция отменена','AbortError'));options.signal?.addEventListener('abort',abort,{once:true});
 worker.onerror=event=>finish(Error(event.message||'Не удалось обработать файл проекта.'));
 worker.onmessage=({data})=>{if(settled)return;if(typeof data.progress==='string'){try{options.progress?.(data.progress);}catch{}return;}if(data.error)finish(Error(data.error));else finish(undefined,kind==='pack'?data.bytes:data.scene);};
 worker.onmessageerror=()=>finish(Error('Не удалось получить результат обработки файла проекта.'));
 try{worker.postMessage(kind==='pack'?{kind,scene:value}:{kind,bytes:value});}catch(error){finish(error);}
});}
