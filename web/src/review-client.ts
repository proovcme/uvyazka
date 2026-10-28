import type {ModelPackage} from './model';
import type {ReviewObject,ClashRule,ClashReport} from './review-model';
const canonical=(value:unknown)=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))):row);

function db():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('uvyazka-review',1);r.onupgradeneeded=()=>r.result.createObjectStore('objects',{keyPath:['project','kind','id','revision']});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function local(operation:'list'|'save',project:string,kind:string,row?:ReviewObject){const d=await db();try{return await new Promise<ReviewObject[]>((resolve,reject)=>{const tx=d.transaction('objects',operation==='save'?'readwrite':'readonly'),s=tx.objectStore('objects'),get=s.getAll();let items:ReviewObject[]=[];get.onsuccess=()=>{items=(get.result as (ReviewObject&{project:string})[]).filter(r=>r.project===project&&r.kind===kind);if(row){const revision=Math.max(0,...items.filter(r=>r.id===row.id).map(r=>r.revision));if(revision!==row.revision-1){tx.abort();return;}s.add({...row,project,created_at:new Date().toISOString()});}};tx.oncomplete=()=>resolve(items);tx.onabort=()=>reject(tx.error??Error('Объект изменился или не хватило места. Перечитайте список.'));tx.onerror=()=>reject(tx.error);});}finally{d.close();}}
export class ReviewRepository {
 constructor(readonly shared:boolean,readonly project:()=>string){}
 async snapshot():Promise<ReviewObject[]>{const project=this.project(),rows:ReviewObject[]=[];for(const kind of ['view','view_template','clash_template','clash_run','issue'])for(const row of await this.list(kind)){rows.push(kind==='clash_run'&&this.shared?await this.get(kind,row.id):row);if(rows.length>10000)throw Error('Слишком много объектов для одного переносимого проекта.');}if(project!==this.project())throw Error('Проект изменился');return rows;}
 async checkSnapshot(rows:ReviewObject[]){
  if(!Array.isArray(rows)||rows.length>10000||rows.some(row=>!['view','view_template','clash_template','clash_run','issue'].includes(row.kind)||typeof row.id!=='string'||!row.id||!row.payload||typeof row.payload!=='object'))throw Error('Некорректные объекты проверки в проекте.');

  const ids=new Set<string>(),project=this.project();for(const kind of new Set(rows.map(row=>row.kind))){const existing=new Map((await this.list(kind)).map(row=>[row.id,row]));for(const row of rows.filter(row=>row.kind===kind)){const key=kind+'\0'+row.id;if(ids.has(key))throw Error('Повторный ID объекта в проекте.');ids.add(key);if(existing.has(row.id)){const previous=await this.get(kind,row.id);if(canonical(previous.payload)!==canonical(row.payload))throw Error('В базе есть другая версия объекта '+row.id+'. Имеющиеся решения сохранены.');}}}if(project!==this.project())throw Error('Проект изменился.');
 }
 async restoreSnapshot(rows:ReviewObject[]){
  await this.checkSnapshot(rows);
  if(!Array.isArray(rows)||rows.length>10000||rows.some(row=>!['view','view_template','clash_template','clash_run','issue'].includes(row.kind)||typeof row.id!=='string'||!row.id||!row.payload||typeof row.payload!=='object'))throw Error('Некорректные объекты проверки в проекте.');
  if(this.shared){for(const row of rows){const old=(await this.list(row.kind)).find(item=>item.id===row.id);if(old){const full=await this.get(row.kind,row.id);if(canonical(full.payload)!==canonical(row.payload))throw Error('В базе есть другая версия объекта '+row.id+'. Импорт её не перезаписывает.');}else await this.save(row.kind,row.id,row.payload,0);}return;}
  const project=this.project(),d=await db();try{await new Promise<void>((resolve,reject)=>{const tx=d.transaction('objects','readwrite'),store=tx.objectStore('objects'),request=store.getAll();request.onsuccess=()=>{for(const row of rows){const existing=(request.result as (ReviewObject&{project:string})[]).filter(item=>item.project===project&&item.kind===row.kind&&item.id===row.id).sort((a,b)=>b.revision-a.revision)[0];if(existing){if(canonical(existing.payload)!==canonical(row.payload)){tx.abort();return;}continue;}store.add({...row,project,revision:1,payload:row.payload,created_at:new Date().toISOString()});}};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('Конфликт объектов: имеющиеся решения не перезаписаны.'));});}finally{d.close();}
 }
 async request(path:string,body?:unknown,extra=''){
  const url='/api/review3d/'+path+'?project_id='+encodeURIComponent(this.project())+extra;
  const headers:Record<string,string>={};if(body!==undefined){const config=await fetch('/api/review3d/config').then(r=>r.json());headers['X-Uvyazka-Token']=config.token;headers['Content-Type']='application/json';}
  const r=await fetch(url,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error??'Ошибка общей базы');return value;
 }
 async list(kind:string):Promise<ReviewObject[]>{if(this.shared){let offset=0;const result:ReviewObject[]=[];while(true){const page=await this.request('objects',undefined,'&kind='+encodeURIComponent(kind)+'&offset='+offset+'&limit=100');result.push(...page.items);if(page.next_offset===null)break;offset=page.next_offset;}return result;}
  const versions=await local('list',this.project(),kind),latest=new Map<string,ReviewObject>();for(const r of versions)if(r.revision>(latest.get(r.id)?.revision??0))latest.set(r.id,r);return [...latest.values()];}
 async save(kind:string,id:string,payload:Record<string,unknown>,revision=0){if(this.shared)return this.request('save',{kind,id,payload,expected_revision:revision,request_id:crypto.randomUUID()});await local('save',this.project(),kind,{kind,id,payload,revision:revision+1});return {revision:revision+1};}
 async get(kind:string,id:string):Promise<ReviewObject>{if(this.shared)return this.request('object',undefined,'&kind='+encodeURIComponent(kind)+'&id='+encodeURIComponent(id));const row=(await this.list(kind)).find(r=>r.id===id);if(!row)throw Error('Объект не найден');return row;}
 async registerModel(model:ModelPackage,binary:ArrayBuffer,progress:(text:string)=>void,cancelled=()=>false){const scene_id=await this.scene(model,binary,progress,cancelled);if(cancelled())throw Error('Сохранение модели отменено.');return this.request('register-model',{scene_id,request_id:crypto.randomUUID()});}
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
