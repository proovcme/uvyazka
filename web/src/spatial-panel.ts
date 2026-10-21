import type {Viewer} from './viewer';
import type {ModelPackage} from './model';
import {measurementKey,measurementRecord} from './spatial-measurements';
import type {SurfacePoint,SpatialMeasurement,MeasureAxis} from './spatial-measurements';

export function spatialPanel(viewer:Viewer|null,getModel:()=>ModelPackage|null,getProject:()=>string,onError:(error:unknown)=>void){
 const button=document.getElementById('measure')!,panel=document.getElementById('measure-controls')!;
 panel.innerHTML=`<strong>Замер по поверхности</strong><p id="measure-message" role="status">Выберите две точки на модели.</p><label>Результат<select id="measure-axis"><option value="distance">Расстояние 3D</option><option>X</option><option>Y</option><option>Z</option></select></label><div class="measure-actions"><button id="measure-next">Новый замер</button><button id="measure-history">Журнал</button><button id="measure-close">Закрыть</button></div><small>Точки на сетке · без привязки к вершинам. Это не минимальный зазор.</small>`;
 const message=panel.querySelector<HTMLElement>('#measure-message')!,axis=panel.querySelector<HTMLSelectElement>('#measure-axis')!;
 let points:SurfacePoint[]=[],active=false,context='';
 function reset(){points=[];context=getModel()?.model_id??'';viewer?.showMeasurement([]);message.textContent='Выберите две точки на модели.';}
 function close(){active=false;panel.hidden=true;button.setAttribute('aria-pressed','false');viewer?.setMeasureHandler(null);reset();}
 button.onclick=()=>{if(active){close();return;}if(!getModel()||!viewer){onError('Сначала откройте модель с геометрией');return;}active=true;panel.hidden=false;button.setAttribute('aria-pressed','true');reset();viewer.setMeasureHandler(point=>{
   const model=getModel();if(!model)return;
   if(context!==model.model_id||points.length===2)reset();points.push(point);viewer.showMeasurement(points.map(p=>p.point_m));
   if(points.length===1){message.textContent='Первая точка выбрана. Укажите вторую.';return;}
   const record=measurementRecord(getProject(),model,points[0],points[1],axis.value as MeasureAxis);
   const result=`${record.value_m.toFixed(3)} м · ΔX ${record.delta_m[0].toFixed(3)} · ΔY ${record.delta_m[1].toFixed(3)} · ΔZ ${record.delta_m[2].toFixed(3)}`;
   try{const records=read();records.push(record);localStorage.setItem(measurementKey(getProject()),JSON.stringify(records));message.textContent=result+' · сохранено в журнале браузера';}
   catch(error){message.textContent=result+' · НЕ сохранено';onError('Не удалось сохранить замер: '+String(error));}
 });};
 panel.querySelector<HTMLButtonElement>('#measure-next')!.onclick=reset;
 panel.querySelector<HTMLButtonElement>('#measure-close')!.onclick=close;
 axis.onchange=reset;
 document.getElementById('canvas')!.addEventListener('measurement-cancel',close);
 function read():SpatialMeasurement[]{const raw=localStorage.getItem(measurementKey(getProject()));const data=raw?JSON.parse(raw):[];if(!Array.isArray(data))throw Error('Повреждён журнал замеров');return data;}
 const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Журнал пространственных замеров');document.body.append(dialog);
 panel.querySelector<HTMLButtonElement>('#measure-history')!.onclick=()=>{
   let records:SpatialMeasurement[];try{records=read();}catch(error){onError(error);return;}
   dialog.replaceChildren();const content=document.createElement('div');content.className='dialog-content';dialog.append(content);
   const title=document.createElement('h2');title.textContent='Замеры проекта';content.append(title);
   const info=document.createElement('p');info.textContent='Наблюдения сохранены в этом браузере. JSON содержит точки, SHA-256 источников, элементы и размещения. В общую базу проекта автоматически не отправляются.';content.append(info);
   for(const r of records.slice().reverse()){
     const row=document.createElement('p');row.textContent=`${r.value_m.toFixed(3)} м (${r.axis}) · ${r.filename} · ${r.model_id===getModel()?.model_id?'текущая модель':'другая модель / ревизия'} · ${new Date(r.created_at).toLocaleString()}`;content.append(row);
     const show=document.createElement('button');show.textContent='Показать точки';show.disabled=r.model_id!==getModel()?.model_id;show.onclick=()=>{viewer?.showMeasurement(r.points.map(p=>p.point_m));viewer?.focusTargets(r.points.map(p=>p.element_id));dialog.close();};content.append(show);
   }
   if(!records.length){const empty=document.createElement('p');empty.textContent='Замеров пока нет';content.append(empty);}
   const download=document.createElement('button');download.textContent='Скачать JSON';download.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({project_id:getProject(),measurements:records},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='uvyazka-spatial-measurements.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};content.append(download);
   const done=document.createElement('button');done.textContent='Закрыть журнал';done.onclick=()=>dialog.close();content.append(done);dialog.showModal();
 };
 return {reset:close};
}
