import type {ViewerState} from './viewer-workspace';
import type {ModelPackage} from './model';
import {validateSpecification} from './model-specification.ts';
export function validateViewerState(state:ViewerState,model:ModelPackage){
 if(!state||state.version!==1||state.model_id!==model.model_id||state.source_sha256!==model.source.sha256||JSON.stringify(state).length>4*1024**2)throw Error('Рабочее место не соответствует модели или превышает допустимый размер.');
 const strings=(v:unknown,max=500000)=>Array.isArray(v)&&v.length<=max&&v.every(x=>typeof x==='string'&&x.length<=512)&&new Set(v).size===v.length;
 const ids=new Set(model.elements.map(e=>e.id));if(!strings(state.hidden)||!strings(state.selection)||[...state.hidden,...state.selection].some(id=>!ids.has(id)))throw Error('В рабочем месте есть неизвестные элементы.');
 const f=state.filters;if(!f||typeof f.query!=='string'||f.query.length>4096||typeof f.system!=='string'||!strings(f.levels)||!strings(f.categories)||!['all','any'].includes(f.combine)||!['categories','levels'].includes(f.grouping)||typeof f.apply3d!=='boolean'||!Array.isArray(f.parameters)||f.parameters.length>100||f.parameters.some(p=>!p||typeof p.name!=='string'||p.name.length>1024||typeof p.value!=='string'||p.value.length>4096||!['contains','equals','exists','missing','gt','gte','lt','lte'].includes(p.operator)))throw Error('Некорректные условия поиска в рабочем месте.');
 const v=state.view,vector=(row:unknown):row is number[]=>Array.isArray(row)&&row.length===3&&row.every(x=>typeof x==='number'&&Number.isFinite(x));
 if(!v||![v.position,v.target,v.up].every(vector)||v.up.every(x=>x===0)||!Array.isArray(v.planes)||v.planes.length>6||typeof v.xray!=='boolean'||v.planes.some(p=>!p||!vector(p.normal)||Math.abs(Math.hypot(...p.normal)-1)>1e-5||!Number.isFinite(p.constant)))throw Error('Некорректный сохранённый вид.');
 if(!Array.isArray(state.measurements)||state.measurements.length>20000||!Array.isArray(state.sets)||state.sets.length>10000||state.sets.some(s=>!s||typeof s.id!=='string'||typeof s.name!=='string'||!['rule','explicit'].includes(s.kind)||!strings(s.ids)||!/^([a-f0-9]{64})$/.test(s.model_id)||!/^([a-f0-9]{64})$/.test(s.source_sha256))||state.specifications!==undefined&&!Array.isArray(state.specifications))throw Error('Некорректные замеры, подборки или таблицы.');
 for(const definition of state.specifications??[])validateSpecification(definition);
}
