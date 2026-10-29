import type {SavedScene} from './viewer-workspace';
export function archiveTask(kind:'pack',value:SavedScene):Promise<Uint8Array>;
export function archiveTask(kind:'unpack',value:ArrayBuffer):Promise<SavedScene>;
export function archiveTask(kind:'pack'|'unpack',value:SavedScene|ArrayBuffer):Promise<any>{return new Promise((resolve,reject)=>{
 const worker=new Worker(new URL('./workspace-archive.worker.ts',import.meta.url),{type:'module'});worker.onerror=event=>{worker.terminate();reject(Error(event.message||'Не удалось обработать файл проекта.'));};worker.onmessage=({data})=>{worker.terminate();if(data.error)reject(Error(data.error));else resolve(kind==='pack'?data.bytes:data.scene);};try{worker.postMessage(kind==='pack'?{kind,scene:value}:{kind,bytes:value});}catch(error){worker.terminate();reject(error);}
 worker.onmessageerror=()=>{worker.terminate();reject(Error('Не удалось получить результат обработки файла проекта.'));};
});}
