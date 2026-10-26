import type {Viewer} from './viewer';
import type {ModelPackage} from './model';
import {measurementKey,measurementRecord,measurementPoint} from './spatial-measurements';
import type {SurfacePoint,MeasureAxis} from './spatial-measurements';
import {planarArea,meshClearance} from './mesh-measure';

export function spatialPanel(viewer:Viewer|null,getModel:()=>ModelPackage|null,getProject:()=>string,onError:(error:unknown)=>void,selection:()=>string[]=()=>[],binary:()=>ArrayBuffer|null=()=>null){
 const button=document.getElementById('measure')!,panel=document.getElementById('measure-controls')!;
 panel.innerHTML=`<strong>Измерения модели</strong><p id="measure-message" role="status">Выберите две точки на модели.</p><label>Результат<select id="measure-axis"><option value="distance">Расстояние 3D</option><option>X</option><option>Y</option><option>Z</option><option value="area">Площадь плоского контура</option></select></label><label class="check"><input id="measure-snap" type="checkbox" checked>Привязки: вершины и рёбра треугольной сетки</label><div class="measure-actions"><button id="measure-next">Новый замер</button><button id="measure-area">Замкнуть контур</button><button id="measure-gap">Зазор двух выбранных</button><button id="measure-history">Журнал</button><button id="measure-close">Закрыть</button></div><small>Ctrl + щелчок — выбрать второй элемент. Зазор измеряется между поверхностями сеток; вложение тел и точность исходной геометрии требуют проверки.</small>`;
 const message=panel.querySelector<HTMLElement>('#measure-message')!,axis=panel.querySelector<HTMLSelectElement>('#measure-axis')!;
 let points:SurfacePoint[]=[],active=false,context='';
 type RecordRow={id:string;model_id:string;filename:string;created_at:string;points:SurfacePoint[];value_m?:number;value_m2?:number;axis?:string;[key:string]:unknown};
 function read():RecordRow[]{const data=JSON.parse(localStorage.getItem(measurementKey(getProject()))??'[]');if(!Array.isArray(data))throw Error('Повреждён журнал замеров');return data;}
 function save(record:RecordRow,result:string){try{const rows=read();rows.push(record);localStorage.setItem(measurementKey(getProject()),JSON.stringify(rows));message.textContent=result+' · сохранено в журнале браузера';document.dispatchEvent(new Event('spatial-measurement-saved'));}catch(error){message.textContent=result+' · НЕ сохранено';onError(error);}}
 function reset(){points=[];context=getModel()?.model_id??'';viewer?.showMeasurement([]);message.textContent=axis.value==='area'?'Укажите точки контура по порядку, затем замкните.':'Выберите две точки на модели.';}
 function close(){active=false;panel.hidden=true;button.setAttribute('aria-pressed','false');viewer?.setMeasureHandler(null);reset();}
 button.onclick=()=>{if(active){close();return;}if(!getModel()||!viewer){onError('Сначала откройте модель с геометрией');return;}active=true;panel.hidden=false;button.setAttribute('aria-pressed','true');reset();viewer.setMeasureHandler(point=>{
   const model=getModel();if(!model)return;
   if(context!==model.model_id||axis.value!=='area'&&points.length===2)reset();points.push(point);viewer.showMeasurement(points.map(p=>p.point_m));
   if(axis.value==='area'){message.textContent=`Точек контура: ${points.length} · ${point.snap??'surface'}`;return;}
   if(points.length===1){message.textContent=`Первая точка: ${point.snap??'surface'}. Укажите вторую.`;return;}
   const record=measurementRecord(getProject(),model,points[0],points[1],axis.value as MeasureAxis);
   save(record,`${record.value_m.toFixed(3)} м · ΔX ${record.delta_m[0].toFixed(3)} · ΔY ${record.delta_m[1].toFixed(3)} · ΔZ ${record.delta_m[2].toFixed(3)}`);
 });};
 panel.querySelector<HTMLButtonElement>('#measure-next')!.onclick=reset;
 panel.querySelector<HTMLButtonElement>('#measure-close')!.onclick=close;
 panel.querySelector<HTMLInputElement>('#measure-snap')!.onchange=event=>{if(viewer)viewer.measureSnap=(event.target as HTMLInputElement).checked;};
 panel.querySelector<HTMLButtonElement>('#measure-area')!.onclick=()=>{try{const model=getModel();if(!model||axis.value!=='area')throw Error('Выберите измерение площади');const area=planarArea(points.map(p=>p.point_m));const source=measurementRecord(getProject(),model,points[0],points[1],'distance');const record:RecordRow={...source,method:'planar_mesh_polygon',axis:'area',value_m2:area,points:points.map(p=>measurementPoint(model,p)),note:'Плоский контур по сетке; допуск плоскостности 1 мм. Не площадь исходной BIM-поверхности.'};delete record.value_m;save(record,`${area.toFixed(3)} м²`);viewer?.showMeasurement([...points.map(p=>p.point_m),points[0].point_m]);}catch(error){onError(error);}};
 const gap=panel.querySelector<HTMLButtonElement>('#measure-gap')!;
 gap.onclick=async()=>{const model=getModel(),data=binary(),ids=selection();if(!model||!data||ids.length!==2){onError('Выберите ровно два элемента через Ctrl + щелчок');return;}gap.disabled=true;message.textContent='Расчёт минимального расстояния между поверхностями…';try{const elements=ids.map(id=>model.elements.find(e=>e.id===id)!);const r=await meshClearance(model,data,elements[0],elements[1]);if(getModel()!==model)throw Error('Модель сменилась во время расчёта');const p=[{element_id:ids[0],point_m:r.a,triangle_index:null},{element_id:ids[1],point_m:r.b,triangle_index:null}];viewer?.showMeasurement(p.map(x=>x.point_m));const record=measurementRecord(getProject(),model,p[0],p[1],'distance');save({...record,method:'exhaustive_triangle_surface_distance',note:'Минимум между треугольными поверхностями. Положительное расстояние не доказывает отсутствие вложения одного тела в другое.'},`${r.distance_m.toFixed(4)} м · между поверхностями`);}catch(error){message.textContent='Зазор не рассчитан';onError(error);}finally{gap.disabled=false;}};
 axis.onchange=reset;document.getElementById('canvas')!.addEventListener('measurement-cancel',close);
 const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Журнал пространственных замеров');document.body.append(dialog);
 panel.querySelector<HTMLButtonElement>('#measure-history')!.onclick=()=>{
   let records:RecordRow[];try{records=read();}catch(error){onError(error);return;}
   dialog.replaceChildren();const content=document.createElement('div');content.className='dialog-content';dialog.append(content);
   const title=document.createElement('h2');title.textContent='Замеры проекта';content.append(title);
   const info=document.createElement('p');info.textContent='Журнал хранится в браузере. Сохранение рабочего места переносит его в общую базу проекта вместе с источниками и состоянием сцены.';content.append(info);
   for(const r of records.slice().reverse()){
     const row=document.createElement('p');row.textContent=`${r.value_m2!==undefined?r.value_m2.toFixed(3)+' м²':r.value_m?.toFixed(3)+' м'} (${r.axis}) · ${r.filename} · ${r.model_id===getModel()?.model_id?'текущая модель':'другая модель / ревизия'} · ${new Date(r.created_at).toLocaleString()}`;content.append(row);
     const show=document.createElement('button');show.textContent='Показать точки';show.disabled=r.model_id!==getModel()?.model_id;show.onclick=()=>{viewer?.showMeasurement(r.points.map(p=>p.point_m));viewer?.focusTargets(r.points.map(p=>p.element_id));dialog.close();};content.append(show);
   }
   if(!records.length){const empty=document.createElement('p');empty.textContent='Замеров пока нет';content.append(empty);}
   const download=document.createElement('button');download.textContent='Скачать JSON';download.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({project_id:getProject(),measurements:records},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='uvyazka-spatial-measurements.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};content.append(download);
   const done=document.createElement('button');done.textContent='Закрыть журнал';done.onclick=()=>dialog.close();content.append(done);dialog.showModal();
 };
 return {reset:close};
}
