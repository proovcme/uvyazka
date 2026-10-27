import type {ModelPackage} from './model';
import type {ReviewObject,ClashRule,ClashReport} from './review-model';

function db():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('uvyazka-review',1);r.onupgradeneeded=()=>r.result.createObjectStore('objects',{keyPath:['project','kind','id','revision']});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function local(operation:'list'|'save',project:string,kind:string,row?:ReviewObject){const d=await db();try{return await new Promise<ReviewObject[]>((resolve,reject)=>{const tx=d.transaction('objects',operation==='save'?'readwrite':'readonly'),s=tx.objectStore('objects'),get=s.getAll();let items:ReviewObject[]=[];get.onsuccess=()=>{items=(get.result as (ReviewObject&{project:string})[]).filter(r=>r.project===project&&r.kind===kind);if(row){const revision=Math.max(0,...items.filter(r=>r.id===row.id).map(r=>r.revision));if(revision!==row.revision-1){tx.abort();return;}s.add({...row,project,created_at:new Date().toISOString()});}};tx.oncomplete=()=>resolve(items);tx.onabort=()=>reject(tx.error??Error('Объект изменился или не хватило места. Перечитайте список.'));tx.onerror=()=>reject(tx.error);});}finally{d.close();}}
export class ReviewRepository {
 constructor(readonly shared:boolean,readonly project:()=>string){}
 async request(path:string,body?:unknown,extra=''){
  const url='/api/review3d/'+path+'?project_id='+encodeURIComponent(this.project())+extra;
  const headers:Record<string,string>={};if(body!==undefined){const config=await fetch('/api/review3d/config').then(r=>r.json());headers['X-Uvyazka-Token']=config.token;headers['Content-Type']='application/json';}
  const r=await fetch(url,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error??'Ошибка общей базы');return value;
 }
 async list(kind:string):Promise<ReviewObject[]>{if(this.shared){let offset=0;const result:ReviewObject[]=[];while(true){const page=await this.request('objects',undefined,'&kind='+encodeURIComponent(kind)+'&offset='+offset+'&limit=100');result.push(...page.items);if(page.next_offset===null)break;offset=page.next_offset;}return result;}
  const versions=await local('list',this.project(),kind),latest=new Map<string,ReviewObject>();for(const r of versions)if(r.revision>(latest.get(r.id)?.revision??0))latest.set(r.id,r);return [...latest.values()];}
 async save(kind:string,id:string,payload:Record<string,unknown>,revision=0){if(this.shared)return this.request('save',{kind,id,payload,expected_revision:revision,request_id:crypto.randomUUID()});await local('save',this.project(),kind,{kind,id,payload,revision:revision+1});return {revision:revision+1};}
 async get(kind:string,id:string):Promise<ReviewObject>{if(this.shared)return this.request('object',undefined,'&kind='+encodeURIComponent(kind)+'&id='+encodeURIComponent(id));const row=(await this.list(kind)).find(r=>r.id===id);if(!row)throw Error('Объект не найден');return row;}
 async scene(model:ModelPackage,binary:ArrayBuffer,progress:(text:string)=>void,cancelled=()=>false){
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',binary))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const state=await this.request('scene-start',{model,binary_sha256:hash});if(state.ready)return state.scene_id;
  const config=await fetch('/api/review3d/config').then(r=>r.json());let offset=state.received;
  while(offset<binary.byteLength){if(cancelled())throw Error('Подготовка отменена. Уже принятые блоки можно использовать повторно.');const end=Math.min(binary.byteLength,offset+state.chunk_bytes);const r=await fetch('/api/review3d/scene-chunk?project_id='+encodeURIComponent(this.project())+'&scene_id='+state.scene_id+'&offset='+offset,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Uvyazka-Token':config.token},body:binary.slice(offset,end)});const result=await r.json();if(!r.ok)throw Error(result.error);offset=result.received;progress(`Сохранение геометрии в проект: ${Math.round(offset/binary.byteLength*100)}%`);}
  return state.scene_id;
 }
 async start(sceneId:string,rule:ClashRule){return this.request('run',{scene_id:sceneId,rule,request_id:crypto.randomUUID()});}
 async job(id:string):Promise<{status:string;report:ClashReport|null;error?:string;activity?:string}>{return this.request('job',undefined,'&id='+encodeURIComponent(id));}
}
