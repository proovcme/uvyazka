import test from 'node:test';
import assert from 'node:assert/strict';
import {ProcessingState,stagesFor,duration} from '../src/processing-state.ts';
import {themeChoice} from '../src/theme.ts';

test('light is the default, explicit dark choice survives; invalid storage cannot set another theme',()=>{
  assert.equal(themeChoice(null),'light');assert.equal(themeChoice('dark'),'dark');assert.equal(themeChoice('system'),'light');
});
test('format-specific steps do not imply RVT conversion for IFC or CAD',()=>{
  assert(stagesFor('a.RVT').includes('RVT → IFC'));assert(!stagesFor('a.ifc').includes('RVT → IFC'));assert.deepEqual(stagesFor('a.dwg'),['Чтение файла','CAD']);
});
test('a responsive UI timer cannot claim the decoder is alive; pong does not advance a step',()=>{
  const s=new ProcessingState();s.begin('a.rvt',200,1000);s.update('RVT → IFC','Conversion',2000);
  assert.equal(s.snapshot(18000).silent,true);assert.equal(s.snapshot(18000).replyAge,null);
  const before=structuredClone(s.steps);s.reply(18000);
  assert.equal(s.snapshot(18001).silent,false);assert.deepEqual(s.steps,before);assert.equal(s.stageAt,2000);
});
test('cache jumps are marked skipped, only observed stages are completed',()=>{
  const s=new ProcessingState();s.begin('a.ifc',100,0);s.update('Хеширование','hash',1);s.update('Отображение','cache hit',3);
  assert.equal(s.steps.find(x=>x.name==='Хеширование')?.state,'done');assert.equal(s.steps.find(x=>x.name==='Геометрия')?.state,'skipped');
  s.finish('completed','Done',60000);assert.equal(s.steps.at(-1)?.state,'done');assert.equal(s.snapshot(999999).elapsed,60000);
});
test('cancel freezes time and refuses late progress; a new file resets everything',()=>{
  const s=new ProcessingState();s.begin('old.rvt',100,1000);s.update('RVT → IFC','old',2000);s.finish('cancelled','Stop',4000);s.update('Отображение','late',10000);s.reply(10000);
  assert.equal(s.stage,'RVT → IFC');assert.equal(s.snapshot(20000).elapsed,3000);assert.equal(s.steps.find(x=>x.name==='RVT → IFC')?.state,'stopped');
  s.begin('new.ifc',200,30000);assert.equal(s.state,'running');assert.equal(s.lastReply,0);assert(!s.steps.some(x=>x.name==='RVT → IFC'));assert.equal(duration(125001),'2:05');
});
