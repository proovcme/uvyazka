/** Explicit LES handoff. Source hashes and native identities, never filename matching. */
import type {ModelPackage} from './model';
export interface LesTarget {project:string;dataset:string;object:string;sha256:string}
export interface LesPresentation {
  prepareModel?:(target:LesTarget,signal:AbortSignal)=>Promise<void>;
  openDrawing?:(target:LesTarget,source:Record<string,unknown>,record:Record<string,unknown>|undefined,signal:AbortSignal)=>Promise<void>;
}
/** Keep integer property values which JavaScript cannot represent exactly as source text. */
export function exactObjectJson(text:string):Record<string,unknown>{
  let out='',quoted=false,escaped=false;
  for(let i=0;i<text.length;){
    const c=text[i];
    if(quoted){out+=c;i++;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;out+=c;i++;continue;}
    if(c==='-'||/[0-9]/.test(c)){
      const token=text.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];
      if(token){out+=/^-?[0-9]+$/.test(token)&&!Number.isSafeInteger(Number(token))?JSON.stringify(token):token;i+=token.length;continue;}
    }
    out+=c;i++;
  }
  return JSON.parse(out) as Record<string,unknown>;
}
export function lesTarget(url:URL):LesTarget|null {
  const q=url.searchParams;
  if(!q.has('les_dataset')&&!q.has('les_object')&&!q.has('les_sha256'))return null;
  const result={project:q.get('project')||'',dataset:q.get('les_dataset')||'',object:q.get('les_object')||'',sha256:q.get('les_sha256')||''};
  if(!Object.values(result).every(s=>s.length>0&&s.length<=512&&!/[\u0000-\u001f]/.test(s))||!/^[a-f0-9]{64}$/.test(result.sha256))throw Error('Некорректная ссылка на источник LES.');
  return result;
}
export function geometryTarget(model:ModelPackage|null,target:LesTarget,record:Record<string,unknown>):string|null {
  if(!model||model.project_id!==target.project||record.section!=='elements')return null;
  const identifiers=(record.identifiers||{}) as Record<string,unknown>;
  const native=String(record.native_id??'');
  const format=model.source.format;
  const matches=model.elements.filter(e=>{
    if(!e.mesh || e.source.file_sha256!==target.sha256&&e.revit?.identity_source?.file_sha256!==target.sha256)return false;
    if(format==='rvt')return e.revit?.element_id===String(identifiers.element_id??native)&&(!identifiers.unique_id||e.revit?.unique_id===identifiers.unique_id);
    if(format==='ifc')return (identifiers.global_id?e.global_id===identifiers.global_id:true)&&String(e.source.step_id)===String(identifiers.step_id??native);
    return false;
  });
  return matches.length===1?matches[0].id:null;
}
export async function showLesSource(target:LesTarget,getModel:()=>ModelPackage|null,focus:(id:string)=>void,presentation:LesPresentation={}):Promise<void>{
  const dialog=document.createElement('dialog');dialog.className='model-data';dialog.setAttribute('aria-label','Источник из LES');
  const title=document.createElement('h2');title.textContent='Источник из LES';
  const close=document.createElement('button');close.textContent='Закрыть';close.onclick=()=>dialog.close();
  const status=document.createElement('p');status.setAttribute('role','status');status.textContent='Проверяю редакцию и читаю объект…';
  const head=document.createElement('div');head.className='panel-head';head.append(title,close);
  status.className='model-data-summary';
  const detail=document.createElement('div');detail.className='model-data-detail';
  const controller=new AbortController();
  dialog.append(head,status,detail);document.body.append(dialog);dialog.addEventListener('close',()=>{controller.abort();dialog.remove();},{once:true});dialog.showModal();
  try{
    let offset=0,text='';let origin:unknown=null,source:Record<string,unknown>={};
    for(let pages=0;pages<32;pages++){
      const url=new URL('/api/models/object',location.origin);
      url.search=new URLSearchParams({project_id:target.project,dataset_id:target.dataset,object_id:target.object,
        verify_source:offset===0?'1':'0',offset:String(offset),max_chars:'12000'}).toString();
      const response=await fetch(url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])});
      if(!response.ok)throw Error('Снимок или объект недоступен в выбранном проекте.');
      const part=await response.json();
      if(part.project_id!==target.project||part.dataset_id!==target.dataset||part.object_id!==target.object||part.source?.sha256!==target.sha256)throw Error('Ссылка относится к другой редакции источника.');
      if(offset===0){if(part.freshness?.status!=='content_hash_matches')throw Error('Оригинал изменился или недоступен. Обновите снимок перед просмотром.');source=part.source;origin=JSON.stringify(part.source);}
      else if(JSON.stringify(part.source)!==origin)throw Error('Источник изменился во время чтения.');
      if(typeof part.text!=='string'||text.length+part.text.length>262144)throw Error('Объект превышает предел просмотра.');
      text+=part.text;const next=offset+Array.from(part.text).length;
      if(part.next_offset===null){if(part.total_chars!==next)throw Error('Не удалось дочитать объект.');break;}
      if(part.next_offset!==next||next<=offset||pages===31)throw Error('Не удалось продолжить чтение объекта.');offset=next;
    }
    const object=exactObjectJson(text);
    if(target.object==='@dataset'){
      if(object.dataset_id!==target.dataset)throw Error('Идентификатор снимка не совпадает.');
      title.textContent=String(source.relative_path??'Файл из LES');
      status.textContent='Редакция подтверждена. Свойства прочитаны из этой версии файла.';
      const format=String(source.format);
      let open: (()=>Promise<void>)|undefined;
      if(presentation.openDrawing&&['dwg','dxf'].includes(format)){
        const draw=presentation.openDrawing;
        open=()=>draw(target,source,undefined,controller.signal);
      }else if(presentation.prepareModel&&['rvt','ifc'].includes(format)){
        const model=presentation.prepareModel;
        open=()=>model(target,controller.signal);
      }
      if(!open){
        status.textContent='Редакция подтверждена. Для этого формата доступен просмотр сохранённых данных.';
        const report=document.createElement('pre');report.textContent=JSON.stringify({
          object_count:object.object_count,reader:object.reader,coverage:object.coverage
        },null,2);detail.append(report);
        return;
      }
      const openFile=open;
      const button=document.createElement('button');button.textContent='Открыть файл';
      const load=async()=>{
        button.disabled=true;status.setAttribute('role','status');status.textContent='Открываю файл этой редакции…';
        try{await openFile();if(!controller.signal.aborted)dialog.close();}
        catch(e){if(!controller.signal.aborted){status.setAttribute('role','alert');status.textContent=e instanceof Error?e.message:'Файл не открыт.';}}
        finally{button.disabled=false;}
      };
      button.onclick=()=>void load();detail.append(button);await load();
      return;
    }
    if(object.object_id!==target.object)throw Error('Идентификатор объекта не совпадает.');
    title.textContent=typeof object.name==='string'&&object.name?object.name:'Объект из LES';
    const label=document.createElement('p');label.textContent=`ID: ${object.native_id??'не указан'} · ${object.category??'категория не указана'}`;detail.append(label);
    const dl=document.createElement('dl');
    const render=(value:unknown,path:string,depth=0)=>{
      if(depth>32)throw Error('Слишком глубокая структура свойств.');
      if(value!==null&&typeof value==='object'&&Object.keys(value).length){for(const [key,item]of Object.entries(value))render(item,path?`${path} / ${key}`:key,depth+1);return;}
      const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=path;dd.textContent=value===null?'Не задано':typeof value==='string'?value:JSON.stringify(value);dl.append(dt,dd);
    };
    render(object.properties,'Свойства');render(object.identifiers??{},'Идентификаторы');detail.append(dl);
    let preparation='';
    if(!geometryTarget(getModel(),target,object)&&presentation.prepareModel&&['rvt','ifc'].includes(String(source.format))){
      status.textContent='Ищу сцену этой редакции…';
      try{await presentation.prepareModel(target,controller.signal);}catch(e){preparation=e instanceof Error?e.message:'Не удалось подготовить сцену.';}
    }
    if(controller.signal.aborted)return;
    const id=geometryTarget(getModel(),target,object);
    status.textContent=id?'Найдена геометрия этой редакции. Свойства не являются утверждённым инженерным решением.':'Показаны свойства точного объекта. В текущей сцене нет однозначной геометрии этой редакции; другой объект не подсвечен.';
    if(preparation)status.textContent+=' '+preparation;
    if(presentation.openDrawing&&['dwg','dxf'].includes(String(source.format))&&object.section==='elements'){
      status.textContent='Свойства этой редакции прочитаны. Можно открыть исходный чертёж и проверить выделение объекта.';
      const button=document.createElement('button');button.textContent='Показать на чертеже';
      button.onclick=async()=>{button.disabled=true;status.textContent='Проверяю оригинал и открываю чертёж…';
        try{await presentation.openDrawing!(target,source,object,controller.signal);if(!controller.signal.aborted)dialog.close();}
        catch(e){status.setAttribute('role','alert');status.textContent=e instanceof Error?e.message:'Чертёж не открыт.';}
        finally{button.disabled=false;}};
      const footer=document.createElement('div');footer.className='model-data-footer';footer.append(button);dialog.append(footer);
    }
    if(id){const footer=document.createElement('div');footer.className='model-data-footer';const button=document.createElement('button');button.textContent='Показать в модели';button.onclick=()=>{const current=geometryTarget(getModel(),target,object);if(current!==id){status.textContent='Сцена изменилась. Откройте источник заново.';return;}dialog.close();focus(id);};footer.append(button);dialog.append(footer);}
  }catch(e){status.setAttribute('role','alert');status.textContent=e instanceof Error?e.message:'Не удалось прочитать источник LES.';}
}
