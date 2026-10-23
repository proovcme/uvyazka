import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {facetFilter} from '../src/facet-filter.ts';
import {cadTreePanel,type CadTreeState} from '../src/cad-tree-panel.ts';

test('facet accepts several levels and reset restores all without sharing mutable selection',t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;
 const host=document.createElement('details');document.body.append(host);let changes=0;
 const facet=facetFilter(host,'Уровни',()=>changes++);facet.setChoices([{id:'L1',name:'Первый'},{id:'L2',name:'Второй'},{id:'null',name:'Без уровня'}]);
 const inputs=host.querySelectorAll<HTMLInputElement>('input');inputs[0].click();inputs[1].click();
 assert.deepEqual([...facet.selected()],['L1','L2']);assert.equal(changes,2);assert.match(host.querySelector('summary')!.textContent!,/2/);
 facet.selected().clear();assert.equal(facet.selected().size,2);
 host.querySelector<HTMLButtonElement>('button')!.click();assert.equal(facet.selected().size,0);assert.equal(changes,3);
 assert.match(host.querySelector('summary')!.textContent!,/все/);
});

test('CAD tree is file/layer/objects with handle search and acknowledged visibility',t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;
 const host=document.createElement('div');document.body.append(host);const commands:Record<string,unknown>[]=[];
 const panel=cadTreePanel(host,command=>commands.push(command));
 const state:CadTreeState={filename:'test.dwg',layers:[{name:'ОВ',visible:true},{name:'АР',visible:false}],entities:[{id:'ABC',type:'LINE',layer:'ОВ',visible:true},{id:'DEF',type:'INSERT',layer:'АР',visible:null}]};
 panel.update(state);const search=host.querySelector<HTMLInputElement>('input[type=search]')!;search.value='ABC';search.dispatchEvent(new win.Event('input') as unknown as Event);
 assert.equal(host.querySelectorAll('.element-item').length,1);host.querySelector<HTMLButtonElement>('.element-item')!.click();
 assert.deepEqual(commands.pop(),{kind:'select-entity',id:'ABC'});
 host.querySelector<HTMLInputElement>('.tree-element-row input')!.click();assert.deepEqual(commands.pop(),{kind:'entity-visibility',id:'ABC',visible:false});
 // A click alone cannot confirm that the CAD engine changed visibility.
 panel.update(state);assert.equal(host.querySelector<HTMLInputElement>('.tree-element-row input')!.checked,true);
 panel.update({...state,entities:state.entities.map(e=>({...e,visible:e.id==='ABC'?false:e.visible}))});assert.equal(host.querySelector<HTMLInputElement>('.tree-element-row input')!.checked,false);
 host.querySelector<HTMLButtonElement>('.tree-isolate')!.click();assert.deepEqual(commands.pop(),{kind:'isolate-layer',layer:'ОВ'});
 search.value='DEF';search.dispatchEvent(new win.Event('input') as unknown as Event);assert.equal(host.querySelector<HTMLInputElement>('.tree-element-row input')!.disabled,true);
 assert.match(host.textContent!,/test.dwg/);assert.match(host.textContent!,/АР/);
});
