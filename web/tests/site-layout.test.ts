import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSite, overlaps } from '../src/site-layout.ts';

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
