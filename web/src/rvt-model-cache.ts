import type {ModelPackage} from './model.ts';
import {validatePackage} from './model.ts';
import type {RvtDocument} from './rvt-document.ts';
import type {RvtMode} from './browser-rvt-direct.ts';

// Advance with native reader patches, bridge output or IFC interpretation changes.
export const RVT_CACHE_REVISION='b6086d41/mep1-bounds1-2021v1/direct1/web-ifc-0.0.78-v2/cache2-native-identity';
export interface CachedRvtModel {model:ModelPackage;binary:ArrayBuffer;document:RvtDocument|null;conversion?:unknown;convertedIfc?:ArrayBuffer|null}
export const rvtCacheKey=(hash:string,mode:RvtMode)=>`${RVT_CACHE_REVISION}:${mode}:${hash}`;
export function validateCachedRvt(value:CachedRvtModel,hash:string,mode:RvtMode){
 const model=value.model;
 if(model.source.format!=='rvt'||model.source.sha256!==hash||(model.source.rvt_read_mode??'ifc')!==mode
   ||!!model.rvt_direct!==(mode==='direct')
   ||model.importer_version!==(mode==='direct'?'uvyazka-rvt-direct-v1':'web-ifc-0.0.78/uvyazka-2'))throw Error('Кеш RVT относится к другому файлу, режиму или обработчику');
 if(value.document&&value.document.source?.sha256!==hash)throw Error('Каталог кеша относится к другому RVT');
 validatePackage(model,value.binary);return value;
}

/** Derived packages only; never saves the original RVT. Independent of project memory. */
export async function rvtModelCache(){
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const r=indexedDB.open('uvyazka-rvt-models',1);
  r.onupgradeneeded=()=>{r.result.createObjectStore('models');r.result.createObjectStore('access');};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Кеш RVT занят другой вкладкой'));
 });
 const transaction=(action:(models:IDBObjectStore,access:IDBObjectStore)=>void)=>new Promise<void>((resolve,reject)=>{
  const tx=db.transaction(['models','access'],'readwrite');action(tx.objectStore('models'),tx.objectStore('access'));
  tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('Запись кеша RVT отменена'));
 });
 return {
  async get(hash:string,mode:RvtMode):Promise<CachedRvtModel|undefined>{
   const key=rvtCacheKey(hash,mode);
   const value=await new Promise<CachedRvtModel|undefined>((resolve,reject)=>{const r=db.transaction('models').objectStore('models').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   if(value){validateCachedRvt(value,hash,mode);await transaction((_models,access)=>{access.put({key,at:Date.now()},key);});}
   return value;
  },
  async put(hash:string,mode:RvtMode,value:CachedRvtModel){
   validateCachedRvt(value,hash,mode);const key=rvtCacheKey(hash,mode);
   await transaction((models,access)=>{
    const r=access.getAll();r.onsuccess=()=>{
     const rows=(r.result as {key:string;at:number}[]).filter(row=>row.key!==key).sort((a,b)=>b.at-a.at);
     const retained=rows.filter(row=>row.key.startsWith(RVT_CACHE_REVISION+':')).slice(0,2);
     for(const row of rows)if(!retained.some(keep=>keep.key===row.key)){models.delete(row.key);access.delete(row.key);}
     models.put(value,key);access.put({key,at:Date.now()},key);
    };
   });
  },
  clear:()=>transaction((models,access)=>{models.clear();access.clear();}),close:()=>db.close()
 };
}
