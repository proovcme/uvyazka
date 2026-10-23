import test from 'node:test';
import assert from 'node:assert/strict';
import {elementIdentity,elementMatches,matchesDataQuery} from '../src/element-identity.ts';
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
