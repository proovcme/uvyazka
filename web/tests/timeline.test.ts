import {test} from 'node:test';
import assert from 'node:assert/strict';
import {timelineRows,timeLabel} from '../src/timeline.ts';
import type {RunPackage} from '../src/simulation.ts';

test('timeline preserves resource-delayed dates, shared work once, and missing dates',()=>{
 const run={duration:200,scenario:{units:[{id:'floor',name:'Floor',operation_ids:['a','b']},{id:'shared',name:'Shared',operation_ids:['a']}],operations:[{id:'a',name:'A',duration:10,evidence:{kind:'assumed'}},{id:'b',name:'B',evidence:{kind:'explicit'}},{id:'c',name:'C',evidence:{kind:'assumed'}}]},operation_states:{a:{start:100,finish:120},b:{start:null,finish:null},c:{start:0,finish:0}}} as unknown as RunPackage;
 const snapshot=JSON.stringify(run),rows=timelineRows(run);
 assert.equal(rows.length,2);assert.equal(rows.flatMap(r=>r.ids).filter(id=>id==='a').length,1);
 assert.deepEqual([rows[0].bars[0].left,rows[0].bars[0].width],[50,10]);
 assert.equal(rows[0].bars[1].start,null);assert.equal(rows[0].bars[1].left,null);
 assert.equal(rows[1].bars[0].width,0);assert.equal(JSON.stringify(run),snapshot);
});
test('timeline labels elapsed days and hours without adding a calendar start date',()=>{
 assert.equal(timeLabel(1440,'days'),'1');assert.equal(timeLabel(90,'hours'),'1,5');assert.equal(timeLabel(0,'minutes'),'0');
});
