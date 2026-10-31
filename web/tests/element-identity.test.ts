import test from 'node:test';
import assert from 'node:assert/strict';
import {elementIdentity,elementMatches,matchesDataQuery,elementLabelMatches} from '../src/element-identity.ts';
import type {BimElement,ModelPackage} from '../src/model.ts';
const e=(properties={})=>({id:'scene:44',name:'Насос',global_id:'ifc-global',class:'IfcPump',property_sets:properties,materials:['Сталь'],storey_id:'level',revit:{element_id:'9007199254740993',unique_id:'native-unique',phase_status:'unavailable'}} as unknown as BimElement);
test('Revit IDs preserve exact strings and never fall back to IFC or scene IDs',()=>{
  const item=e();assert.equal(elementIdentity(item).element_id,'9007199254740993');delete item.revit;
  assert.equal(elementIdentity(item).element_id,null);
  item.property_sets={Asset:{ElementId:44},Other:{RevitElementId:123}};assert.equal(elementIdentity(item).element_id,'123');
  item.property_sets={One:{RevitElementId:123},Two:{RevitElementId:124}};assert.equal(elementIdentity(item).status,'conflict');
});
test('search includes parameters and linked systems; exact Revit query excludes similar numbers',()=>{
  const item=e({Technical:{Power:'15 кВт',Mark:'Н-17'}}),model={elements:[item],storeys:[{id:'level',name:'Этаж 2'}],systems:[{id:'s1',name:'Водоснабжение',member_ids:[item.id]}]} as unknown as ModelPackage;
  assert.equal(elementMatches(item,model,'15 кВт'),true);assert.equal(elementMatches(item,model,'водоснабжение'),true);
  assert.equal(elementMatches(item,model,'revit:9007199254740993'),true);assert.equal(elementMatches(item,model,'revit:44'),false);
  assert.equal(matchesDataQuery({revit_identity:elementIdentity(item)},'revit:9007199254740993'),true);
});
test('repeated data search serializes a revision record only once and a new revision gets a new index',()=>{
  let reads=0;const record={get description(){reads++;return 'Насос 15 кВт';}};
  assert.equal(matchesDataQuery(record,'насос'),true);
  assert.equal(matchesDataQuery(record,'15 кВт'),true);
  assert.equal(matchesDataQuery(record,'вентилятор'),false);
  assert.equal(reads,1);
  assert.equal(matchesDataQuery({description:'Вентилятор'},'вентилятор'),true);
});
test('simple finder matches names, family/type and exact IDs, excluding unrelated numeric quantities',()=>{
 const item={...e({Technical:{Power:812345,Family:'Grundfos',Type:'CR-15'}}),step_id:44};
 assert.equal(elementLabelMatches(item,'насос'),true);
 assert.equal(elementLabelMatches(item,'Grundfos CR-15'),true);
 assert.equal(elementLabelMatches(item,'IfcPump'),true);
 assert.equal(elementLabelMatches(item,'#44'),true);
 assert.equal(elementLabelMatches(item,'#scene:44'),true);
 assert.equal(elementLabelMatches(item,'revit:9007199254740993'),true);
 assert.equal(elementLabelMatches(item,'812345'),false);
 assert.equal(elementLabelMatches(item,'#4'),false);
});

test('shared property inspection preserves namespace-specific IDs, conflicts and new revisions',()=>{
 let reads=0;const shared={get ElementId(){reads++;return '9007199254740993';},Family:'Семейство',UniqueId:'uid'};
 const one={...e({Other:shared})};delete one.revit;
 const two={...e({Revit:shared})};delete two.revit;
 assert.equal(elementIdentity(one).element_id,null);assert.equal(elementIdentity(two).element_id,'9007199254740993');
 assert.equal(elementIdentity(two).unique_id,'uid');assert.equal(elementLabelMatches(one,'семейство'),true);
 for(let i=0;i<20;i++)assert.equal(elementIdentity({...two,id:String(i)}).element_id,'9007199254740993');assert.equal(reads,1);
 const changed={...two,property_sets:{Revit:{ElementId:'77'}}};assert.equal(elementIdentity(changed).element_id,'77');
 assert.equal(elementIdentity({...two,property_sets:{Revit:shared,Other:{RevitElementId:'88'}}}).status,'conflict');
});
