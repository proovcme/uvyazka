import test from 'node:test';
import assert from 'node:assert/strict';
import type {BimElement,ModelPackage} from '../src/model.ts';
import {ModelVisibility} from '../src/model-visibility.ts';
import {modelTreeNodes} from '../src/model-tree-panel.ts';
import {parameterMatches,parameterCatalog} from '../src/parameter-search.ts';
function item(id:string,source='ar',fields:Record<string,unknown>={Power:0,Mark:'Н-17',FireRating:'EI 60'}){
 return {id,name:'Насос '+id,role:'element',source_instance_id:source,storey_id:'L1',class:'IfcPump',property_sets:{Technical:fields},quantity_sets:{},materials:['Сталь'],global_id:'ifc-'+id,mesh:{},revit:{element_id:id}} as unknown as BimElement;
}
function fixture(elements:BimElement[]){return {elements,source:{filename:'clinic.ifc'},storeys:[{id:'L1',name:'Этаж 1'}],federation:{members:[{instance_id:'ar',label:'АР'},{instance_id:'ov',label:'ОВ'}]}} as unknown as ModelPackage;}
test('visibility survives filtering and isolation can be reversed per element or in full',()=>{
 const visibility=new ModelVisibility(),ids=['ar:1','ov:1','ov:2'];visibility.set(['ov:1'],false);
 assert.deepEqual(visibility.count(ids),{total:3,shown:2,checked:false,mixed:true});
 visibility.isolate(['ov:2'],ids);assert.equal(visibility.visible('ar:1'),false);
 visibility.set(['ar:1'],true);assert.equal(visibility.visible('ar:1'),true);assert.equal(visibility.visible('ov:1'),false);
 visibility.reset();assert.deepEqual(visibility.count(ids),{total:3,shown:3,checked:true,mixed:false});
});
test('model tree retains every item past 1000 and separates instances with the same floor/category',()=>{
 const items=Array.from({length:1201},(_,i)=>item(String(i),i%2?'ar':'ov')),model=fixture(items),nodes=modelTreeNodes(model,items);
 assert.equal(nodes.length,2);assert.equal(nodes.reduce((n,s)=>n+s.items.length,0),1201);
 assert.equal(new Set(nodes.flatMap(s=>s.children.map(f=>f.key))).size,2);
 assert.equal(nodes.flatMap(s=>s.children.flatMap(f=>f.children.flatMap(c=>c.items))).length,1201);
});
test('parameter name and value are matched in the same field, with explicit zero and missing distinguished',()=>{
 const e=item('9007199254740993');
 assert.equal(parameterMatches(e,{name:'Power',operator:'equals',value:'0'}),true);
 assert.equal(parameterMatches(e,{name:'Mark',operator:'equals',value:'EI 60'}),false);
 assert.equal(parameterMatches(e,{name:'Power',operator:'exists',value:''}),true);
 assert.equal(parameterMatches(e,{name:'Absent',operator:'missing',value:''}),true);
 assert.equal(parameterMatches(e,{name:'Revit ElementId',operator:'equals',value:'9007199254740993'}),true);
 assert.equal(parameterMatches(e,{name:'Power',operator:'missing',value:''}),false);
 const missing=item('2','ov',{Power:null});assert.equal(parameterMatches(missing,{name:'Power',operator:'missing',value:''}),true);
 assert.ok(parameterCatalog(fixture([e])).includes('Свойства · Technical · Power'));
});
test('numeric parameter comparisons never strip or convert unit strings or nulls',()=>{
 const filter={name:'Power',operator:'gt' as const,value:'10,5'};
 assert.equal(parameterMatches(item('1','ar',{Power:12}),filter),true);
 assert.equal(parameterMatches(item('2','ar',{Power:'12 кВт'}),filter),false);
 assert.equal(parameterMatches(item('3','ar',{Power:null}),{...filter,value:'-1'}),false);
 assert.equal(parameterMatches(item('4','ar',{Power:12}),{...filter,value:''}),false);
 assert.equal(parameterMatches(item('9007199254740993'),{name:'Revit ElementId',operator:'gt',value:'1'}),false);
});
