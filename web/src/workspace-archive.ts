import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {validatePackage} from './model.ts';
import {federationBudget} from './federation.ts';
import type {SavedScene} from './viewer-workspace';
import type {ModelPackage} from './model';
import {validateViewerState} from './viewer-state-validation.ts';
import {encodeSharedJson,decodeSharedJson} from './shared-json.ts';
const MAX_BYTES=768*1024**2,MAX_JSON=64*1024**2,MAX_MODEL_JSON=256*1024**2,MAX_FILES=260;
const hash=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))].map(n=>n.toString(16).padStart(2,'0')).join('');
function assertScene(scene:SavedScene){
 if(!scene||scene.state?.version!==1||scene.state.model_id!==scene.model?.model_id||scene.state.source_sha256!==scene.model?.source.sha256||!Array.isArray(scene.members)||scene.members.length>128||!Array.isArray(scene.state.hidden)||!Array.isArray(scene.state.selection)||typeof scene.project_id!=='string'||!scene.project_id||scene.project_id.length>128)throw Error('Некорректный проект вьювера.');
 validatePackage(scene.model,scene.binary);federationBudget(scene.members);
 validateViewerState(scene.state,scene.model);
 if(scene.documents!==undefined&&(!Array.isArray(scene.documents)||scene.documents.length>128||scene.documents.some(doc=>!doc||!doc.source||!/^[a-f0-9]{64}$/.test(doc.source.sha256)||!Array.isArray(doc.records)||doc.records.length>500000||doc.records.some(record=>!record||!record.identity||!['string','number'].includes(typeof record.identity.element_id)||typeof record.class_name!=='string'||!['view','schedule','placement'].includes(record.kind)||record.graph&&(!Array.isArray(record.graph.objects)||!Array.isArray(record.graph.edges)))||doc.schedule_data&&!Array.isArray(doc.schedule_data.records))))throw Error('Повреждён каталог документа в проекте.');
 const ids=new Set(scene.model.elements.map(e=>e.id));if(ids.size!==scene.model.elements.length||[...scene.state.hidden,...scene.state.selection].some(id=>!ids.has(id)))throw Error('Состояние проекта ссылается на неизвестные элементы.');
 const v=scene.state.view;if(!v||[v.position,v.target,v.up].some(row=>!Array.isArray(row)||row.length!==3||!row.every(Number.isFinite))||!Array.isArray(v.planes)||v.planes.length>6)throw Error('Некорректный сохранённый вид.');
}
export async function packWorkspace(scene:SavedScene,progress:(message:string)=>void=()=>{}):Promise<Uint8Array>{
 progress('Проверка состава сцены…');assertScene(scene);const files:Record<string,Uint8Array>={};
 const put=(name:string,bytes:Uint8Array)=>{if(bytes.byteLength>((name==='models.json'||name.startsWith('models/'))?MAX_MODEL_JSON:name.endsWith('.json')?MAX_JSON:512*1024**2))throw Error('Файл проекта превышает бюджет.');if(files[name])throw Error('Повторный путь в проекте.');files[name]=bytes;};
 const models=new Map<string,{model:ModelPackage;binary:ArrayBuffer}>();
 for(const entry of [scene,...scene.members]){if(!/^[a-f0-9]{64}$/.test(entry.model.model_id))throw Error('Неверный ID пакета модели.');const old=models.get(entry.model.model_id);if(old&&(old.model!==entry.model&&JSON.stringify(encodeSharedJson(old.model))!==JSON.stringify(encodeSharedJson(entry.model))||await hash(new Uint8Array(old.binary))!==await hash(new Uint8Array(entry.binary))))throw Error('Конфликт пакетов с одинаковым ID.');models.set(entry.model.model_id,entry);}
 const modelMetadata:Record<string,ModelPackage>={};for(const [id,item]of models){validatePackage(item.model,item.binary);modelMetadata[id]=item.model;put(`geometry/${id}.bin`,new Uint8Array(item.binary));}
 progress('Подготовка свойств моделей…');
 put('models.json',strToU8(JSON.stringify(encodeSharedJson(modelMetadata))));
 const {model,binary,members,...metadata}=scene;
 put('scene.json',strToU8(JSON.stringify({...metadata,model_ref:model.model_id,members:members.map(({model,binary,...member})=>({...member,model_ref:model.model_id}))})));
 progress('Проверка контрольных сумм…');
 const checksums:Record<string,string>={};let total=0;for(const [path,bytes]of Object.entries(files)){total+=bytes.byteLength;if(total>MAX_BYTES)throw Error('Проект превышает бюджет экспорта.');checksums[path]=await hash(bytes);}
 put('manifest.json',strToU8(JSON.stringify({contract:'UvyazkaViewerProject',version:2,files:checksums,original_files_included:false,interpretation:'derived_data_and_unapproved_observations'})));
 progress('Сжатие файла проекта…');return zipSync(files,{level:1});
}
export async function unpackWorkspace(bytes:Uint8Array,progress:(message:string)=>void=()=>{}):Promise<SavedScene>{
 progress('Распаковка проекта…');if(bytes.byteLength>MAX_BYTES)throw Error('Архив проекта превышает бюджет.');let expanded=0,count=0;const seen=new Set<string>();
 const files=unzipSync(bytes,{filter:file=>{if(seen.has(file.name)||++count>MAX_FILES||!/^(manifest\.json|scene\.json|models\.json|models\/[a-f0-9]{64}\.json|geometry\/[a-f0-9]{64}\.bin)$/.test(file.name)||file.originalSize>((file.name==='models.json'||file.name.startsWith('models/'))?MAX_MODEL_JSON:file.name.endsWith('.json')?MAX_JSON:512*1024**2)||(expanded+=file.originalSize)>MAX_BYTES)throw Error('Недопустимый путь или размер внутри проекта.');seen.add(file.name);return true;}});
 const parse=(path:string)=>{const value=files[path];if(!value)throw Error('В проекте отсутствует '+path);return JSON.parse(strFromU8(value));};
 const manifest=parse('manifest.json');if(manifest.contract!=='UvyazkaViewerProject'||![1,2].includes(manifest.version)||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw Error('Неизвестный формат проекта.');
 progress('Проверка состава и контрольных сумм…');
 const declared=Object.keys(manifest.files);if(declared.length!==Object.keys(files).length-1)throw Error('Состав архива не совпадает с манифестом.');
 for(const path of declared){if(path==='manifest.json'||!Object.hasOwn(files,path)||!Object.hasOwn(manifest.files,path)||await hash(files[path])!==manifest.files[path])throw Error('Контрольная сумма проекта не совпала: '+path);}
 progress('Восстановление свойств моделей…');
 const sharedModels=manifest.version===2?decodeSharedJson(parse('models.json')) as Record<string,ModelPackage>:null;
 if(manifest.version===2&&(!sharedModels||typeof sharedModels!=='object'||Array.isArray(sharedModels)||Object.keys(sharedModels).length>129))throw Error('Неверный каталог моделей проекта');
 const decoded=new Map<string,{model:ModelPackage;binary:ArrayBuffer}>();
 const get=(id:string)=>{if(!/^[a-f0-9]{64}$/.test(id))throw Error('Недопустимая ссылка на модель.');if(decoded.has(id))return decoded.get(id)!;const model=(manifest.version===2?sharedModels![id]:parse(`models/${id}.json`)) as ModelPackage,raw=files[`geometry/${id}.bin`];if(!model||model.model_id!==id||!raw)throw Error('Пакет модели не найден.');const binary=raw.slice().buffer as ArrayBuffer;validatePackage(model,binary);const entry={model,binary};decoded.set(id,entry);return entry;};
 progress('Проверка геометрии и сохранённого вида…');
 const metadata=parse('scene.json');if(!Array.isArray(metadata.members))throw Error('Нет состава сцены.');const {model_ref,members,...rest}=metadata;
 const scene:SavedScene={...rest,...get(model_ref),members:members.map(({model_ref,...member}:any)=>({...member,...get(model_ref)}))};assertScene(scene);return scene;
}
