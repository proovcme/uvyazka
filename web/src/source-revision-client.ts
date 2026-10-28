import type {ModelPackage} from './model';
import type {compareRevisions} from './revision-diff';
export function inspectRevision(before:ModelPackage,after:ModelPackage,signal:AbortSignal):Promise<{report:ReturnType<typeof compareRevisions>;mapping:[string,string][]}>{return new Promise((resolve,reject)=>{
 if(signal.aborted){reject(Error('Обновление источника отменено.'));return;}
 const worker=new Worker(new URL('./source-revision.worker.ts',import.meta.url),{type:'module'}),cleanup=()=>{worker.terminate();signal.removeEventListener('abort',cancel);},cancel=()=>{cleanup();reject(Error('Обновление источника отменено.'));};signal.addEventListener('abort',cancel,{once:true});
 worker.onerror=event=>{cleanup();reject(Error(event.message||'Не удалось сравнить ревизии.'));};worker.onmessage=({data})=>{cleanup();if(data.error)reject(Error(data.error));else resolve(data);};worker.postMessage({before,after});
});}
