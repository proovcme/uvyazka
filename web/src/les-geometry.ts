import type {LesTarget} from './les-source';

/** CAD handles are hexadecimal source identifiers, never display names. */
export function cadEntityTarget(entities:{id:string}[],record:Record<string,unknown>):string {
  const canonical=(id:unknown)=>typeof id==='string'&&/^[0-9a-f]+$/i.test(id)?id.toUpperCase().replace(/^0+(?=.)/,''):null;
  if(record.section!=='elements')throw Error('Этот объект не является видимой сущностью чертежа. Свойства остаются доступны.');
  const ids=record.identifiers as Record<string,unknown>|undefined;
  const handle=canonical(ids?.handle??record.native_id);
  if(!handle)throw Error('У объекта нет подтверждённого CAD handle.');
  const matches=entities.filter(e=>canonical(e.id)===handle);
  if(matches.length!==1)throw Error('В пространстве модели нет однозначной сущности с этим handle. Другой объект не выбран.');
  return matches[0].id;
}

/** Select only one exact saved scene; never guess using a filename. */
export async function sceneForSource(target:LesTarget,signal?:AbortSignal):Promise<string|null>{
  const matches=new Set<string>();let offset=0;
  for(let pages=0;pages<20;pages++){
    const query=new URLSearchParams({project_id:target.project,offset:String(offset),limit:'100'});
    const response=await fetch('/api/construction/models?'+query,{signal});
    if(!response.ok)throw Error('Не удалось прочитать список сцен. Свойства источника доступны.');
    const page=await response.json();if(page.project_id!==target.project||!Array.isArray(page.items))throw Error('Список сцен относится к другому проекту.');
    for(const model of page.items)if(model.source_sha256===target.sha256&&/^[a-f0-9]{64}$/.test(model.model_id))matches.add(model.model_id);
    if(matches.size>1)return null;
    if(page.next_offset===null)return matches.size===1?[...matches][0]:null;
    if(!Number.isSafeInteger(page.next_offset)||page.next_offset<=offset)throw Error('Не удалось продолжить список сцен.');
    offset=page.next_offset;
  }
  throw Error('Список сцен прочитан не полностью. Автоматический выбор не выполнен.');
}

export async function cadOriginal(target:LesTarget,source:Record<string,unknown>,signal?:AbortSignal):Promise<File>{
  const limit=64*1024*1024;
  if(!['dwg','dxf'].includes(String(source.format))||source.sha256!==target.sha256)throw Error('Исходник чертежа не соответствует ссылке.');
  const query=new URLSearchParams({project_id:target.project,dataset_id:target.dataset,object_id:target.object,sha256:target.sha256});
  const response=await fetch('/api/models/original?'+query,{signal});
  if(!response.ok)throw Error(response.status===413?'Чертёж превышает бюджет вьювера 64 МиБ. Свойства доступны.':'Не удалось открыть исходник этой редакции. Обновите снимок.');
  if(response.headers.get('X-Uvyazka-Source-SHA256')!==target.sha256||Number(response.headers.get('Content-Length'))>limit||!response.body)throw Error('Исходник не прошёл проверку редакции или размера.');
  const reader=response.body.getReader(),parts:Uint8Array<ArrayBuffer>[]= [];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Чертёж превышает бюджет вьювера.');parts.push(new Uint8Array(value));}}
  catch(e){await reader.cancel();throw e;}
  const data=await new Blob(parts).arrayBuffer();
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(digest!==target.sha256)throw Error('Содержимое исходника не совпадает с редакцией ссылки.');
  return new File([data],String(source.relative_path??'drawing.'+source.format).split(/[\\/]/).pop()!,{type:'application/octet-stream'});
}
