import type {SpecDefinition} from './model-specification';
import type {ModelPackage} from './model';
import type {SceneMember} from './federation';
import type {ParameterFilter} from './parameter-search';
export interface ViewerState {
 specifications?:SpecDefinition[];
 version:1;model_id:string;source_sha256:string;hidden:string[];selection:string[];
 filters:{query:string;levels:string[];categories:string[];system:string;parameters:ParameterFilter[];combine:'all'|'any';apply3d:boolean;grouping:'categories'|'levels'};
 view:{position:number[];target:number[];up:number[];planes:{normal:number[];constant:number}[];xray:boolean};
 measurements:unknown[];sets:SelectionSet[];
}
export interface SelectionSet {id:string;name:string;model_id:string;source_sha256:string;kind:'explicit'|'rule';ids:string[];filters?:ViewerState['filters'];created_at:string}
export interface SavedScene {id:string;project_id:string;name:string;created_at:string;state:ViewerState;model:ModelPackage;binary:ArrayBuffer;members:SceneMember[]}
function db():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('uvyazka-viewer-workspaces',1);r.onupgradeneeded=()=>r.result.createObjectStore('scenes',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function sceneStore(action:'get'|'put'|'delete'|'list',value:SavedScene|string):Promise<SavedScene|SavedScene[]|undefined>{const database=await db();try{return await new Promise((resolve,reject)=>{const tx=database.transaction('scenes',action==='put'||action==='delete'?'readwrite':'readonly'),store=tx.objectStore('scenes');const request=action==='put'?store.put(value):action==='delete'?store.delete(value as string):action==='get'?store.get(value as string):store.getAll();let result:unknown;request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result as SavedScene|SavedScene[]|undefined);tx.onabort=()=>reject(tx.error??request.error);tx.onerror=()=>reject(tx.error??request.error);});}finally{database.close();}}
export async function sharedWorkspace(project:string,operation:'get'|'save',state?:ViewerState,expectedRevision?:number){
 const base='/api/viewer/workspace?project_id='+encodeURIComponent(project);
 if(operation==='get'){const r=await fetch(base);if(!r.ok)throw Error('Общая база недоступна: '+r.status);return r.json();}
 const config=await fetch('/api/viewer/config').then(async r=>{if(!r.ok)throw Error('Общая база недоступна');return r.json();});
 const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','X-Uvyazka-Token':config.token},body:JSON.stringify({state,expected_revision:expectedRevision??0,request_id:crypto.randomUUID()})});
 const result=await response.json();if(!response.ok)throw Error(result.error??'Не удалось сохранить рабочее место');return result;
}
