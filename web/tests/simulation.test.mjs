import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/simulation.ts', import.meta.url), 'utf8');
const compiled = await transform(source, { loader:'ts', format:'esm' });
const { projectState, PlaybackClock } = await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
test('parallel operations on one target complete only when all operations finish',()=>{
 const run={scenario:{resources:[],operations:[{id:'long',target_ids:['x'],visual_phase:'work'},{id:'short',target_ids:['x'],visual_phase:'work'}],units:[{target_ids:['x'],operation_ids:['long','short']}]},events:[{time:0,kind:'operation_started',operation_id:'long'},{time:0,kind:'operation_started',operation_id:'short'},{time:5,kind:'operation_completed',operation_id:'short'},{time:10,kind:'operation_completed',operation_id:'long'}]};
 assert.equal(projectState(run,5).construction.get('x'),'active');
 assert.equal(projectState(run,10).construction.get('x'),'complete');
 assert.equal(projectState(run,0).completed,0);
});
test('playback pauses and speed only affect the presentation clock',()=>{
 const clock=new PlaybackClock(100);clock.advance(1);assert.equal(clock.time,0);
 clock.playing=true;clock.rate=10;clock.advance(2);assert.equal(clock.time,20);
 clock.seek(200);assert.equal(clock.time,100);clock.advance(1);assert.equal(clock.playing,false);
});
