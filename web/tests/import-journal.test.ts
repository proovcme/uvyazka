import test from 'node:test';
import assert from 'node:assert/strict';
import {ImportJournal,filePolicy,textReport,compactDetails} from '../src/import-journal.ts';
import type {ImportRun,JournalStorage} from '../src/import-journal.ts';
function memory():JournalStorage & {records:Map<string,ImportRun>} {
  const records=new Map<string,ImportRun>();return {records,load:async()=>[...records.values()].map(r=>structuredClone(r)),save:async run=>{records.set(run.id,structuredClone(run));}};
}
test('partial document import is persisted as partial, not success or cancellation',async()=>{
 const store=memory(),journal=new ImportJournal(store,'tab'),run=journal.begin('import','synthetic.rvt',100);
 journal.finish(run,'partial','Каталог доступен, геометрия не прочитана',{readable_document:true});
 journal.finish(run,'cancelled','late event');await journal.flush();
 const restored=new ImportJournal(store,'tab');await restored.restore();assert.equal(restored.runs[0].state,'partial');assert.equal(restored.runs[0].warnings,1);
});
test('large RVT/IFC files get a warning, not the former demo rejection',()=>{
  for(const name of ['project.rvt','project.IFC'])for(const size of [65,129,512]){
    const result=filePolicy(name,size*1024**2);assert.equal(result.error,undefined);assert.ok(result.warning);
  }
  assert.ok(filePolicy('a.rvt',2*1024**3+1).error);
  assert.ok(filePolicy('a.rvt',0).error);assert.ok(filePolicy('a.zip',100).error);
  assert.ok(filePolicy('a.dwg',65*1024**2).error);
});
test('timings, source, warnings and final state survive persistence; late events cannot rewrite a finished run',async()=>{
  let clock=1000000;const store=memory(),journal=new ImportJournal(store,'tab',()=>{},()=>clock);
  const run=journal.begin('import','source.rvt',90000000);
  clock+=250;journal.progress(run,'RVT → IFC','Конверсия');journal.source(run,'abc123');
  clock+=600;journal.event(run,'warning','Один элемент без сетки',{element_id:'42'});
  clock+=150;journal.finish(run,'completed','Готово');journal.finish(run,'failed','Запоздалое сообщение');
  journal.event(run,'error','Ещё одно запоздалое сообщение');await journal.flush();
  const saved=store.records.get(run.id)!;
  assert.equal(saved.state,'completed');assert.equal(saved.warnings,1);assert.equal(saved.errors,0);
  assert.equal(saved.sha256,'abc123');assert.equal(saved.events.at(-1)!.elapsed_ms,1000);
  assert.equal((saved.events.at(-1)!.details as any).stage_duration_ms,750);
  const restored=new ImportJournal(store,'tab');await restored.restore();assert.equal(restored.runs[0].state,'completed');
  assert.match(textReport(restored.runs[0]),/abc123/);assert.match(textReport(saved),/element_id/);
});
test('reload marks unfinished own work interrupted without changing another tab',async()=>{
  const store=memory(),first=new ImportJournal(store,'first'),second=new ImportJournal(store,'other');
  const a=first.begin('import','a.rvt',1),b=second.begin('import','b.rvt',2);await Promise.all([first.flush(),second.flush()]);
  const restored=new ImportJournal(store,'first');await restored.restore();await restored.flush();
  assert.equal(store.records.get(a.id)!.state,'interrupted');assert.equal(store.records.get(b.id)!.state,'running');
});
test('storage failure is visible while export and processing state remain available',async()=>{
  const journal=new ImportJournal({load:async()=>[],save:async()=>{throw Error('quota');}},'tab');
  const run=journal.begin('import','broken.rvt',10);journal.finish(run,'failed','Invalid CFB',{stage:'RVT → IFC'});await journal.flush();
  assert.match(journal.storageError,/quota/);assert.match(textReport(run),/Invalid CFB/);assert.equal(run.state,'failed');
});
test('bounded history states omissions instead of pretending it is complete',async()=>{
  const journal=new ImportJournal(memory(),'tab');const run=journal.begin('import','large.rvt',1);
  for(let i=0;i<1005;i++)journal.event(run,'info',String(i));journal.finish(run,'cancelled','Остановлено');
  assert.equal(run.events.length,1000);assert.equal(run.omitted_events,7);assert.equal(run.events[0].message,'Запуск обработки');
  assert.equal((compactDetails({message:'x'.repeat(70000)}) as any).truncated,true);await journal.flush();
});
