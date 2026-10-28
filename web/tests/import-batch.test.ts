import test from 'node:test';
import assert from 'node:assert/strict';
import {importBatch,batchSummary} from '../src/import-batch.ts';
import type {BatchSnapshot,FileImportResult} from '../src/import-batch.ts';
import {filePolicy} from '../src/import-journal.ts';
import {stagesFor} from '../src/processing-state.ts';
const files=['bad.nwc','a.nwc','b.NWC'].map(name=>({name,size:128}));
const result=(included:boolean,state:FileImportResult['state']=included?'partial':'failed'):FileImportResult=>({state,included,message:included?'Прочитан с ограничениями':'Повреждённый контейнер'});
test('batch waits for each decoder and preserves replacement until a model is displayed',async()=>{
 const calls:boolean[]=[],snapshots:BatchSnapshot[]=[];let active=0,max=0;
 const final=await importBatch(files,async(file,append)=>{calls.push(append);max=Math.max(max,++active);await Promise.resolve();active--;return result(file.name!=='bad.nwc');},{append:false,signal:new AbortController().signal,update:s=>snapshots.push(s)});
 assert.deepEqual(calls,[false,false,true]);assert.equal(max,1);assert.deepEqual(final.rows.map(r=>r.state),['failed','partial','partial']);assert.equal(final.finished,true);assert.match(batchSummary(final),/Добавлено в сцену: 2 из 3/);assert.equal(snapshots[0].rows[0].state,'waiting');
});
test('partial catalogue without displayed geometry cannot replace the next model with append',async()=>{
 const calls:boolean[]=[];
 await importBatch(files,async(_,append)=>{calls.push(append);return result(false,'partial');},{append:false,signal:new AbortController().signal,update:()=>{}});
 assert.deepEqual(calls,[false,false,false]);
});
test('append mode keeps an existing scene even when a decoder rejects a file',async()=>{
 const calls:boolean[]=[];await importBatch(files,async(_,append)=>{calls.push(append);return result(false);},{append:true,signal:new AbortController().signal,update:()=>{}});assert.deepEqual(calls,[true,true,true]);
});
test('cancelling the current file leaves remaining files unstarted',async()=>{
 let calls=0;const final=await importBatch(files,async()=>{calls++;return result(false,'cancelled');},{append:false,signal:new AbortController().signal,update:()=>{}});assert.equal(calls,1);assert.equal(final.cancelled,true);assert.deepEqual(final.rows.map(r=>r.state),['cancelled','cancelled','cancelled']);assert.match(final.rows[1].message,/Не запускался/);
});
test('external cancellation preserves completed files and never starts a remaining decoder',async()=>{
 const controller=new AbortController();let calls=0;const final=await importBatch(files,async()=>{calls++;controller.abort();return result(true);},{append:false,signal:controller.signal,update:()=>{}});assert.equal(calls,1);assert.equal(final.rows[0].included,true);assert.equal(final.rows[1].state,'cancelled');
});
test('one thrown parser error does not cancel the rest; CAD cannot silently replace a 3D batch',async()=>{
 let calls=0;const final=await importBatch([{name:'drawing.dwg',size:10},...files],async()=>{calls++;if(calls===1)throw Error('Bad stream');return result(true);},{append:false,signal:new AbortController().signal,update:()=>{}});assert.equal(calls,3);assert.equal(final.rows[0].state,'failed');assert.match(final.rows[0].message,/Чертежи открываются отдельно/);assert.equal(final.rows[1].message,'Bad stream');assert.equal(final.rows[3].included,true);
});
test('NWC policy and observed stages use the Navis decoder, never IFC',()=>{
 assert.equal(filePolicy('source.NWC',128).error,undefined);assert.match(filePolicy('source.nwc',513*1024**2).error!,/512 MiB/);assert.deepEqual(stagesFor('source.NWC'),stagesFor('source.nwd'));assert.ok(!stagesFor('source.nwc').includes('IFC-движок'));
});
test('skipped current files and duplicates do not stop the queue or count as newly displayed sources',async()=>{
 let calls=0;const final=await importBatch(files,async()=>++calls===1?result(false,'skipped'):result(true),{append:false,signal:new AbortController().signal,update:()=>{}});assert.equal(calls,3);assert.equal(final.cancelled,false);assert.match(batchSummary(final),/Добавлено в сцену: 2 из 3/);assert.match(batchSummary(final),/Пропущено: 1/);
});
