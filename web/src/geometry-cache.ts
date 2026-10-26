import type {ModelPackage} from './model.ts';
import {validatePackage} from './model.ts';
// Bump whenever importIfc/schema interpretation changes. RVT uses its own catalogue cache.
export const GEOMETRY_REVISION='web-ifc-0.0.78/uvyazka-2/cache-4-network';
export const geometryKey=(hash:string)=>`${GEOMETRY_REVISION}:${hash}`;
export interface CachedGeometry {model:ModelPackage;binary:ArrayBuffer;accessed:number}
export function validCachedGeometry(value:CachedGeometry,hash:string){
  if(value.model.source.sha256!==hash||value.model.model_id!==hash||value.model.importer_version!=='web-ifc-0.0.78/uvyazka-2')throw Error('Кеш относится к другой модели или версии обработчика');
  validatePackage(value.model,value.binary);return value;
}
export async function geometryCache(){
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('uvyazka-ifc-geometry',1);r.onupgradeneeded=()=>r.result.createObjectStore('models');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Кеш занят другой вкладкой'));});
 const transaction=(action:(store:IDBObjectStore)=>void)=>new Promise<void>((resolve,reject)=>{const t=db.transaction('models','readwrite');action(t.objectStore('models'));t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error??Error('Запись кеша отменена'));});
 return {
  async get(hash:string):Promise<CachedGeometry|undefined>{
    const v=await new Promise<CachedGeometry|undefined>((resolve,reject)=>{const r=db.transaction('models').objectStore('models').get(geometryKey(hash));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    if(v)validCachedGeometry(v,hash);return v;
  },
  async put(hash:string,model:ModelPackage,binary:ArrayBuffer){
    // Keep at most three derived packages. A quota failure never prevents import.
    await transaction(store=>{const keys=store.getAllKeys();const request=store.getAll();request.onsuccess=()=>{
      for(const key of keys.result)if(!String(key).startsWith(GEOMETRY_REVISION+':'))store.delete(key);
      const old=(request.result as CachedGeometry[]).filter(v=>geometryKey(v.model.source.sha256)!==geometryKey(hash)).sort((a,b)=>b.accessed-a.accessed);
      for(const v of old.slice(2))store.delete(geometryKey(v.model.source.sha256));
      store.put({model,binary,accessed:Date.now()},geometryKey(hash));
    };});
  },
  clear:()=>transaction(store=>store.clear()),close:()=>db.close()
 };
}
