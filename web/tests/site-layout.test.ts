import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSite, overlaps } from '../src/site-layout.ts';
import { workerMotion } from '../src/worker-motion.ts';

test('fleet swept corridors are disjoint and inside site for capacity 1..8 and translated models',()=>{
  for(const count of [1,2,4,8]) for(const offset of [-300,0,250]) for(const radius of [1,8,30]) {
    const building={minX:offset-5,maxX:offset+5,minZ:offset-4,maxZ:offset+4};
    const resources=['crane','truck','mixer','excavator','dump_truck','compactor','concrete_pump','vibrator','crew'].map(id=>({id,capacity:count}));
    const layout=layoutSite(building,resources,radius), bays=[...layout.bays.values()];
    for(const [i,bay] of bays.entries()) {
      assert.equal(overlaps(bay.envelope,building),false,bay.id+' building');
      for(const other of bays.slice(i+1))assert.equal(overlaps(bay.envelope,other.envelope),false,bay.id+' '+other.id);
      assert.ok(bay.envelope.minX>=layout.bounds.minX && bay.envelope.maxX<=layout.bounds.maxX);
      assert.ok(bay.envelope.minZ>=layout.bounds.minZ && bay.envelope.maxZ<=layout.bounds.maxZ);
    }
    for(const p of layout.staging.values())for(const b of bays)assert.equal(overlaps({minX:p[0]-.4,maxX:p[0]+.4,minZ:p[2]-.4,maxZ:p[2]+.4},b.envelope),false);
  }
});

test('active workers repeat walking and work strokes, idle/blocked remain idle, seek is deterministic',()=>{
  const lease:any={start:0,end:240,resource:'concrete_crew',operation:{kind:'concreting'}};
  const samples=Array.from({length:240},(_,tick)=>workerMotion(lease,tick,0,true,false));
  assert.ok(samples.filter(s=>s.travel>.1).length>30);
  assert.ok(new Set(samples.map(s=>s.arm)).size>50);
  assert.ok(samples.some(s=>s.action==='работа с бетоном / опалубкой'));
  const before=workerMotion(lease,103.7,1,true,false);
  workerMotion(lease,1,1,true,false);workerMotion(lease,239,1,true,false);
  assert.deepEqual(workerMotion(lease,103.7,1,true,false),before);
  assert.equal(workerMotion(lease,100,0,true,true).arm,0);
  assert.equal(workerMotion(undefined,100,0,true,false).walk,0);
});
