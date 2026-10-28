import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {renderCellSource,rowNeedsReview} from '../src/cell-source.ts';
import type {ValueCell} from '../src/rvt-schedule.ts';
test('source card explains missing data without inventing a value, keeps raw evidence closed and labels the copy action',async t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;
 const host=document.createElement('div');document.body.append(host);
 renderCellSource(host,{field:'Мощность',value:'Не прочитано',cell:{state:'missing',reason:'Параметр отсутствует в прочитанных данных',evidence:[]},sources:['synthetic.rvt'],owners:[{label:'Revit ID экземпляра',id:'9007199254740993'}],technical:{private_decoder_field:'only-on-demand'}});
 assert.match(host.textContent!,/Параметр отсутствует/);assert.match(host.textContent!,/synthetic.rvt/);assert.equal(host.querySelector('pre'),null);assert.equal(host.querySelector('details')!.open,false);
 assert.equal(host.querySelector<HTMLButtonElement>('button[data-copy]')!.dataset.copy,'9007199254740993');
 const detail=host.querySelector('details')!;detail.open=true;detail.dispatchEvent(new win.Event('toggle') as unknown as Event);assert.match(host.querySelector('pre')!.textContent!,/only-on-demand/);
});
test('review display distinguishes known zero and empty string from missing, mixed, unconfirmed and unknown membership',()=>{
 const zero:ValueCell={state:'value',value:0,evidence:[]};
 assert.equal(rowNeedsReview([zero],'pass'),false);assert.equal(rowNeedsReview([{...zero,value:''}],'pass'),false);
 for(const state of ['missing','conflict','mixed','unsupported'] as const)assert.equal(rowNeedsReview([{state,evidence:[]}],'pass'),true);
 assert.equal(rowNeedsReview([{...zero,confirmed:false}],'pass'),true);assert.equal(rowNeedsReview([zero],'unknown'),true);
});
