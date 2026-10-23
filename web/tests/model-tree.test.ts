import test from 'node:test';
import assert from 'node:assert/strict';
import type {BimElement,ModelPackage} from '../src/model.ts';
import {ModelVisibility} from '../src/model-visibility.ts';
import {modelTreeNodes} from '../src/model-tree-panel.ts';
import {parameterMatches,parameterCatalog,parametersMatch} from '../src/parameter-search.ts';
import {elementCategory} from '../src/element-category.ts';
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
 const items=Array.from({length:1201},(_,i)=>item(String(i),i%2?'ar':'ov')),model=fixture(items),nodes=modelTreeNodes(model,items,'levels');
 assert.equal(nodes.length,2);assert.equal(nodes.reduce((n,s)=>n+s.items.length,0),1201);
 assert.equal(new Set(nodes.flatMap(s=>s.children.map(f=>f.key))).size,2);
 assert.equal(nodes.flatMap(s=>s.children.flatMap(f=>f.children.flatMap(c=>c.items))).length,1201);
});

test('default tree is model/category/elements; source format decides native categories',()=>{
 const a=item('1'),b=item('2');b.property_sets={Other:{Category:'Насосы'}};
 const model=fixture([a,b]);model.source.format='rvt';
 assert.equal(elementCategory(a,model).name,'Категория Revit не прочитана');
 assert.equal(elementCategory(b,model).name,'Насосы');
 const tree=modelTreeNodes(model,[a,b]);assert.equal(tree[0].children[0].kind,'class');assert.equal(tree[0].children[1].items[0].id,'2');
 model.source.format='ifc';b.revit={element_id:'2',id_basis:'ifc_tag_revit_export'};
 assert.equal(elementCategory(b,model).name,'IfcPump');
 model.federation!.members[0].source_format='rvt';assert.equal(elementCategory(b,model).name,'Насосы');
});

test('multiple parameter conditions support AND and OR without treating absent fields as zero',()=>{
 const e=item('1','ar',{Power:0,Mark:'Н-17'}),filters=[{name:'Power',operator:'equals' as const,value:'0'},{name:'Mark',operator:'equals' as const,value:'Н-18'}];
 assert.equal(parametersMatch(e,filters,'all'),false);assert.equal(parametersMatch(e,filters,'any'),true);
 assert.equal(parametersMatch(e,[],'any'),true);
 assert.equal(parametersMatch(e,[{name:'Absent',operator:'equals',value:'0'}]),false);
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
