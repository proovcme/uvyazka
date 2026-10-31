import type {SavedScene} from './viewer-workspace';
import {sceneIfcTask} from './scene-ifc-client';
import {userMessage,addDiagnostics} from './ui-language.ts';

export function sceneIfcPanel(parent:HTMLElement,dialog:HTMLDialogElement,capture:()=>Pick<SavedScene,'model'|'binary'|'state'>,visible?:()=>string[]){
 const section=document.createElement('section');section.className='scene-ifc-panel';section.setAttribute('aria-labelledby','scene-ifc-heading');
 section.innerHTML='<h3 id="scene-ifc-heading">Экспорт IFC</h3><p>Координационная выгрузка прочитанной геометрии и свойств. Исходные ID сохраняются в свойствах IFC.</p><p class="scene-ifc-summary"></p><label>Выгрузить<select aria-label="Состав экспорта IFC"><option value="all">Всю сцену</option><option value="visible">Только видимые элементы</option></select></label><label class="scene-ifc-check"><input type="checkbox" checked data-properties>Свойства элементов</label><details><summary>Состав выгрузки</summary><p>В файл входят модели сцены с их размещениями, уровнями и прочитанными участниками систем. Сечения, камера и объекты симуляции в выгрузку не входят. Тела выгружаются целиком.</p><p>Геометрия записывается как координационные объекты IFC; исходные классы и прочитанные количества сохранены в свойствах. Параметрические тела и непрочитанные части исходников не восстанавливаются.</p><label class="scene-ifc-check"><input type="checkbox" data-evidence>Подробные источники свойств</label></details><div class="scene-ifc-actions"><button type="button" class="scene-ifc-primary">Подготовить IFC</button><button type="button" data-cancel hidden>Отменить</button><a hidden download="uvyazka-scene.ifc">Скачать подготовленный IFC</a></div><p role="status" aria-live="polite"></p>';
 parent.append(section);
 const summary=section.querySelector('.scene-ifc-summary')!,scope=section.querySelector('select')!,properties=section.querySelector<HTMLInputElement>('[data-properties]')!,evidence=section.querySelector<HTMLInputElement>('[data-evidence]')!,start=section.querySelector<HTMLButtonElement>('.scene-ifc-primary')!,cancel=section.querySelector<HTMLButtonElement>('[data-cancel]')!,link=section.querySelector('a')!,status=section.querySelector<HTMLElement>('[role=status]')!;
 let job:AbortController|null=null,url:string|null=null;
 const cleanup=()=>{job?.abort();if(url){URL.revokeObjectURL(url);url=null;}};
 dialog.addEventListener('close',cleanup);addEventListener('pagehide',cleanup);
 const dispose=()=>{cleanup();dialog.removeEventListener('close',cleanup);removeEventListener('pagehide',cleanup);};
 if(!visible)scope.options[1].disabled=true;
 let scene:ReturnType<typeof capture>;
 try{scene=capture();const count=scene.model.elements.filter(e=>e.mesh&&e.mesh.index_count>0).length;summary.textContent=`Моделей: ${scene.model.federation?.members.length??1} · объектов с геометрией: ${count}`;if(!count)throw Error('Добавьте модель с геометрией.');}
 catch{summary.textContent='Добавьте 3D-модель, чтобы подготовить IFC.';start.disabled=true;return dispose;}
 cancel.onclick=()=>job?.abort();
 start.onclick=async()=>{
  if(job)return;const controller=job=new AbortController();start.disabled=true;scope.disabled=properties.disabled=evidence.disabled=true;cancel.hidden=false;link.hidden=true;section.querySelector('.ui-diagnostics')?.remove();
  if(url){URL.revokeObjectURL(url);url=null;}
  try{
   const snapshot=capture();
   const ids=scope.value==='visible'?visible?.():undefined;
   status.textContent='Подготовка IFC…';section.setAttribute('aria-busy','true');
   const result=await sceneIfcTask(snapshot.model,snapshot.binary,{ids,properties:properties.checked,detailedSources:evidence.checked},controller.signal,message=>{status.textContent=message;});
   if(capture().model.model_id!==snapshot.model.model_id)throw Error('Сцена изменилась. Подготовьте IFC заново.');
   url=URL.createObjectURL(new Blob(result.chunks as Uint8Array<ArrayBuffer>[],{type:'application/x-step'}));link.href=url;link.hidden=false;link.click();status.textContent=`IFC подготовлен: ${result.report.products} объектов с геометрией. Если скачивание не началось, нажмите ссылку.`;
  }catch(error){if(error instanceof DOMException&&error.name==='AbortError')status.textContent='Экспорт отменён. Сцена осталась открыта.';else{status.textContent=userMessage(error);addDiagnostics(section,error instanceof Error?error.message:String(error));}}
  finally{job=null;start.disabled=false;scope.disabled=properties.disabled=evidence.disabled=false;cancel.hidden=true;section.removeAttribute('aria-busy');}
 };
 return dispose;
}
