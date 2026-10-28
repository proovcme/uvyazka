import {federationBudget} from './federation';
import type {SceneMember} from './federation';
import type {ModelPackage} from './model';
export async function prepareScene(members:SceneMember[],options:{signal?:AbortSignal;progress?:(text:string)=>void}={}):Promise<{model:ModelPackage;binary:ArrayBuffer}>{
 federationBudget(members);if(options.signal?.aborted)throw Error('Подготовка сцены отменена.');
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./federation.worker.ts',import.meta.url),{type:'module'});
  const cleanup=()=>{worker.terminate();options.signal?.removeEventListener('abort',cancel);};
  const cancel=()=>{cleanup();reject(Error('Подготовка сцены отменена. Предыдущая сцена сохранена.'));};options.signal?.addEventListener('abort',cancel,{once:true});
  worker.onerror=event=>{cleanup();reject(Error(event.message||'Не удалось подготовить сцену. Обновите вкладку; предыдущая сцена сохранена.'));};
  worker.onmessageerror=()=>{cleanup();reject(Error('Не удалось получить подготовленную сцену. Предыдущая сцена сохранена.'));};
  worker.onmessage=({data})=>{if(data.kind==='progress'){try{options.progress?.(data.text);}catch{}return;}cleanup();if(data.kind==='ready')resolve({model:data.model,binary:data.binary});else reject(Error(data.message||'Не удалось собрать сцену.'));};
  try{worker.postMessage({members});}catch(error){cleanup();reject(error);}
 });
}
