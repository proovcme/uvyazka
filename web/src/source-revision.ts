import {elementIdentity} from './element-identity.ts';
import type {BimElement,ModelPackage} from './model';
import type {ViewerState} from './viewer-workspace';
import {elementCategory} from './element-category.ts';
export function revisionIdMap(before:ModelPackage,after:ModelPackage){
 const identity=(element:BimElement)=>{const id=elementIdentity(element),native=element.nwd?.native_guid;return (element.semantic_kind??element.role)+':'+(id.unique_id?'unique:'+id.unique_id:element.global_id?'global:'+element.global_id:native?'native:'+native:id.element_id?'revit:'+id.element_id:'');};
 const index=(model:ModelPackage)=>{const map=new Map<string,string[]>();for(const element of model.elements){const key=identity(element);if(key.endsWith(':'))continue;const ids=map.get(key)??[];ids.push(element.id);map.set(key,ids);}return map;};
 const a=index(before),b=index(after),result=new Map<string,string>();for(const [key,old]of a){const next=b.get(key);if(old.length===1&&next?.length===1)result.set(old[0],next[0]);}return result;
}
export function remapRevisionState(state:ViewerState,before:ModelPackage,after:ModelPackage,targetInstance:string,sourceMap:Map<string,string>){
 const old=new Map(before.elements.map(element=>[element.id,element])),next=new Map(after.elements.map(element=>[(element.source_instance_id??targetInstance)+'\0'+(element.source_element_id??element.id),element.id]));let unresolved=0;
 const translate=(ids:string[])=>ids.flatMap(id=>{const element=old.get(id);if(!element){unresolved++;return [];}const instance=element.source_instance_id??targetInstance,source=element.source_element_id??element.id,target=instance===targetInstance?sourceMap.get(source):source;const mapped=target===undefined?undefined:next.get(instance+'\0'+target);if(!mapped){unresolved++;return [];}return [mapped];});
 const hidden=translate(state.hidden),selection=translate(state.selection),delta=before.coordinate_system.render_origin_m.map((value,index)=>value-after.coordinate_system.render_origin_m[index]);const shift=[delta[0],delta[2],-delta[1]];
 const moved=(value:number[])=>value.map((n,index)=>n+shift[index]);
 const categories=new Set(after.elements.map(element=>elementCategory(element,after).key));
 return {unresolved,state:{...state,model_id:after.model_id,source_sha256:after.source.sha256,hidden,selection,filters:{...state.filters,levels:[],system:'',categories:state.filters.categories.filter(key=>categories.has(key))},view:{...state.view,position:moved(state.view.position),target:moved(state.view.target),planes:state.view.planes.map(plane=>({...plane,constant:plane.constant-plane.normal.reduce((n,value,index)=>n+value*shift[index],0)}))},measurements:state.measurements.map(value=>value&&typeof value==='object'?{...value,review_status:'requires_review',stale_after_source_sha256:after.source.sha256}:value)}};
}
