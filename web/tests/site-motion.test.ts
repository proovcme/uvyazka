import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLeases, activeLease, progress, truckPose, liftPose } from '../src/site-motion.ts';
import { MOBILE_CRANE, mobileCraneRig } from '../src/crane-rig.ts';

const run:any = {scenario:{resources:[{id:'truck',capacity:1},{id:'crane',capacity:1}],operations:[{id:'delivery',kind:'delivery',target_ids:['1']},{id:'lift',kind:'lifting',target_ids:['1']}]},
 events:[{time:0,kind:'resource_acquired',resource_id:'truck',operation_id:'delivery',amount:1,used:1},
 {time:10,kind:'resource_released',resource_id:'truck',operation_id:'delivery',amount:1,used:0},
 {time:10,kind:'resource_acquired',resource_id:'crane',operation_id:'lift',amount:1,used:1},
 {time:30,kind:'resource_released',resource_id:'crane',operation_id:'lift',amount:1,used:0}]};
const leases = compileLeases(run);
test('resource slots match the actual lease journal at every event timestamp', () => {
  for (const time of new Set(run.events.map((event: any) => event.time))) {
    for (const resource of run.scenario.resources) {
      const acquired = run.events.filter((event: any) => event.time <= time && event.resource_id === resource.id && event.used !== undefined).at(-1)?.used ?? 0;
      const busy = leases.filter((lease) => lease.resource === resource.id && lease.start <= Number(time) && Number(time) < lease.end);
      assert.equal(busy.length, acquired);
      assert.equal(new Set(busy.map((lease) => lease.slot)).size, busy.length);
    }
  }
});
test('truck only travels and unloads during its own operation, never while idle', () => {
  const lease = leases.find((lease) => lease.resource === 'truck')!;
  const park: [number, number, number] = [-15, 0, -24], dock: [number, number, number] = [-15, 0, 3];
  assert.deepEqual(truckPose(undefined, 123, park, dock).position, park);
  assert.equal(truckPose(lease, lease.start + (lease.end - lease.start) * .5, park, dock).unloading, true);
  assert.equal(activeLease(leases, 'truck', lease.slot, lease.start)?.operation.id, lease.operation.id);
  assert.notEqual(activeLease(leases, 'truck', lease.slot, lease.end)?.operation.id, lease.operation.id);
});
test('motion is a pure function of virtual time and reproduces after backwards seeking', () => {
  const lease = leases.find((lease) => lease.resource === 'crane')!;
  const pose = (t: number) => liftPose(progress(lease, t), [-9, 0, 0], [-13, .7, -6], [2, 4.5, 0], [-13, 12, -6], 12, .3);
  const at = lease.start + (lease.end - lease.start) * .55;
  const before = pose(at);
  pose(lease.end); pose(lease.start);
  assert.deepEqual(pose(at), before);
  assert.equal(before.phase, 'перенос');
  assert.ok(before.position[1] >= 12);
  assert.equal(pose(lease.start + (lease.end - lease.start) * .96).installed, true);
});

test('mobile boom clears occupied geometry and rejects reach beyond its provisional envelope', () => {
  const pivot: [number, number, number] = [-5, 2.2, 0];
  const obstacle = { min: [0, 0, -1] as [number, number, number], max: [4, 8, 1] as [number, number, number] };
  const rig = mobileCraneRig(pivot, [5, 6, 0], [obstacle]);
  assert.equal(rig.reachable, true);
  for (const t of [.5, .6, .7, .8, .9]) assert.ok(pivot[1] + (rig.head[1] - pivot[1]) * t > obstacle.max[1] + .6);
  assert.equal(mobileCraneRig(pivot, [40, 6, 0]).reachable, false);
  assert.equal(mobileCraneRig([1, 2.2, 0], [5, 6, 0], [obstacle]).reachable, false);
  const rest = mobileCraneRig(pivot, [-5, 2.75, -6]);
  assert.ok(Math.abs(rest.length - MOBILE_CRANE.retractedLength) < .001);
  assert.equal(MOBILE_CRANE.loadMassKg, null);
});
