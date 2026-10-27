import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {modelTreePanel} from '../src/model-tree-panel.ts';
import {ModelVisibility} from '../src/model-visibility.ts';
import type {BimElement,ModelPackage} from '../src/model.ts';

test('tree checkboxes hide and restore rows, mixed branches and isolation use complete IDs',t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;
 const host=document.createElement('div');document.body.append(host);const visibility=new ModelVisibility();
 const items=Array.from({length:3},(_,i)=>({id:String(i),name:'Насос '+i,role:'element',class:i===2?'IfcWall':'IfcPump',storey_id:'L1',mesh:{},property_sets:{}} as BimElement));
 const model={elements:items,source:{filename:'sample.ifc'},storeys:[{id:'L1',name:'Этаж 1'}]} as ModelPackage;
 const selections:string[]=[];
 const render=()=>tree.render(model,items,null,true);
 const tree=modelTreePanel(host,visibility,{select:id=>selections.push(id),show:(ids,shown)=>{visibility.set(ids,shown);render();},isolate:ids=>{visibility.isolate(ids,items.map(e=>e.id));render();}});render();
 host.querySelector<HTMLInputElement>('.tree-element-row input')!.click();
 assert.equal(visibility.visible('0'),false);assert.equal(host.querySelector('.tree-element-row')!.getAttribute('data-visible'),'false');
 assert.equal(host.querySelector<HTMLInputElement>('.branch-model>summary input')!.indeterminate,true);
 host.querySelector<HTMLInputElement>('.tree-element-row input')!.click();assert.equal(visibility.visible('0'),true);
 host.querySelector<HTMLButtonElement>('.branch-class .tree-isolate')!.click();assert.equal(visibility.visible('2'),false);
 assert.equal(selections.length,0);assert.equal(host.querySelectorAll('.tree-element-row').length,3);
 host.querySelector<HTMLButtonElement>('.element-item')!.click();assert.deepEqual(selections,['0']);
});

test('large categories are lazy, every row is reachable, selection beyond 1000 opens its page',t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;const host=document.createElement('div');document.body.append(host);
 const items=Array.from({length:1201},(_,i)=>({id:String(i),name:'Элемент '+i,role:'element',class:'IfcWall',storey_id:'L1',mesh:{},property_sets:{}} as BimElement));
 const model={elements:items,source:{filename:'large.ifc'},storeys:[{id:'L1',name:'Этаж'}]} as ModelPackage;
 const tree=modelTreePanel(host,new ModelVisibility(),{select:()=>{},show:()=>{},isolate:()=>{}});
 tree.render(model,items,null,false);assert.equal(host.querySelectorAll('.element-item').length,0);
 const category=host.querySelector<HTMLDetailsElement>('.branch-class')!;category.open=true;category.dispatchEvent(new win.Event('toggle') as unknown as Event);
 assert.equal(host.querySelectorAll('.element-item').length,50);
 host.querySelector<HTMLButtonElement>('.tree-more')!.click();assert.equal(host.querySelectorAll('.element-item').length,50);assert.equal(host.querySelector('.element-item')!.getAttribute('data-id'),'50');
 tree.reveal('1200');assert.equal(host.querySelector('.element-item')!.getAttribute('data-id'),'1200');assert.equal(host.querySelectorAll('.element-item').length,1);
 host.querySelector<HTMLButtonElement>('.tree-more')!.click();assert.equal(host.querySelector('.element-item')!.getAttribute('data-id'),'1150');
 const branch=host.querySelector<HTMLDetailsElement>('.branch-class')!;branch.open=false;branch.dispatchEvent(new win.Event('toggle') as unknown as Event);
 tree.render(model,items,null,true,'new search');assert.equal(host.querySelector<HTMLDetailsElement>('.branch-class')!.open,true);
});

test('NWD branches page source nodes, retain direct fragments and expose node properties without meshes',t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;
 const host=document.createElement('div');document.body.append(host);const chosen:string[]=[];
 const root={id:'node:0',name:'Synthetic source',class:'LcOaPartition',role:'other',semantic_kind:'source_node',property_sets:{},nwd:{kind:'node',parent_id:null}} as unknown as BimElement;
 const children=Array.from({length:61},(_,i)=>({...root,id:'node:'+String(i+1),name:'Source '+(i+1),nwd:{kind:'node',parent_id:root.id}} as BimElement));
 const fragment={id:'fragment:1',name:'Direct fragment',role:'element',class:'NwdFragment',mesh:{},property_sets:{},nwd:{kind:'fragment',owner_id:root.id}} as unknown as BimElement;
 const model={source:{filename:'synthetic.nwd'},storeys:[],elements:[root,...children,fragment]} as unknown as ModelPackage;
 const tree=modelTreePanel(host,new ModelVisibility(),{select:id=>chosen.push(id),show:()=>{},isolate:()=>{}});
 tree.render(model,model.elements,null,false);
 assert.equal(host.querySelectorAll('.branch-native').length,50);
 assert.equal(host.querySelector('.element-item')!.getAttribute('data-id'),fragment.id,'parent-owned geometry is not dropped when a node also has children');
 host.querySelector<HTMLButtonElement>('.tree-node-actions button:last-child')!.click();assert.deepEqual(chosen,[root.id]);
 host.querySelector<HTMLButtonElement>('.tree-more')!.click();assert.equal(host.querySelectorAll('.branch-native').length,11);
 assert.match(host.querySelector('.branch-native .tree-node-name')!.textContent!,/Source 51/);
});
