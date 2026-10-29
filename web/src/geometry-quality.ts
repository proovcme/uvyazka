import type {BimElement} from './model.ts';
/** Human-facing form quality; never promotes source quantities or parser confidence. */
export function geometryQuality(element:BimElement){
 const evidence=element.geometry_evidence;if(!evidence)return null;
 if(evidence.engine==='rvt_native_saved_graphics')return {kind:'saved',message:'Сохранённая графика RVT. Полнота исходной модели не подтверждена.'};
 if(evidence.status==='bounding_box')return {kind:'bounds',message:'Показан габаритный блок. Точная форма не прочитана; объём и площадь по нему не подтверждены.'};
 if(evidence.status==='unknown')return {kind:'unknown',message:'Происхождение формы не установлено. Геометрия требует проверки.'};
 if(evidence.requires_review)return {kind:'reconstructed',message:'Геометрия восстановлена из RVT. Требует сверки с исходной моделью.'};
 return null;
}
