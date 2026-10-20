import type {RvtDocument} from './rvt-document';
const VERSION='native-document-v1';
/** Content addressed local snapshot; source RVT bytes are never stored here. */
export async function documentCache(){
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('uvyazka-rvt-documents',1);r.onupgradeneeded=()=>r.result.createObjectStore('documents');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Хранилище занято другой вкладкой'));});
 return {
  async get(hash:string):Promise<RvtDocument|undefined>{return new Promise((resolve,reject)=>{const r=db.transaction('documents').objectStore('documents').get(`${VERSION}:${hash}`);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});},
  async put(hash:string,document:RvtDocument){await new Promise<void>((resolve,reject)=>{const tx=db.transaction('documents','readwrite');tx.objectStore('documents').put(document,`${VERSION}:${hash}`);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('Сохранение отменено'));});},
  close:()=>db.close()
 };
}
