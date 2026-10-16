/** Pure, deterministic presentation tracks derived from resource lease events. */
import type { Operation, RunPackage } from './simulation';

export type Point = [number, number, number];
export interface Lease { resource: string; slot: number; operation: Operation; start: number; end: number }
export const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
export const smooth = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };
export const lerpPoint = (a: Point, b: Point, t: number): Point => a.map((v, i) => v + (b[i] - v) * smooth(t)) as Point;
export const progress = (lease: Lease, tick: number) => clamp01((tick - lease.start) / (lease.end - lease.start));

export function compileLeases(run: RunPackage) {
  const operations = new Map(run.scenario.operations.map((operation) => [operation.id, operation]));
  const slots = new Map(run.scenario.resources.map((resource) => [resource.id, Array<string | null>(resource.capacity).fill(null)]));
  const open = new Map<string, Lease[]>();
  const result: Lease[] = [];
  for (const event of run.events) {
    if (!event.resource_id || !event.operation_id) continue;
    const key = `${event.resource_id}/${event.operation_id}`;
    const resourceSlots = slots.get(event.resource_id);
    if (!resourceSlots) throw new Error(`Неизвестный ресурс ${event.resource_id}`);
    if (event.kind === 'resource_acquired') {
      const amount = (event as typeof event & { amount: number }).amount;
      const operation = operations.get(event.operation_id)!;
      const leases = open.get(key) ?? [];
      for (let count = 0; count < amount; count++) {
        const slot = resourceSlots.indexOf(null);
        if (slot < 0) throw new Error(`Двойное назначение ${event.resource_id}`);
        resourceSlots[slot] = operation.id;
        const lease = { resource: event.resource_id, slot, operation, start: event.time, end: Infinity };
        leases.push(lease); result.push(lease);
      }
      open.set(key, leases);
    }
    if (event.kind === 'resource_released') {
      for (const lease of open.get(key) ?? []) {
        lease.end = event.time;
        resourceSlots[lease.slot] = null;
      }
      open.delete(key);
    }
  }
  if (open.size) throw new Error('Журнал содержит незавершённые назначения ресурсов');
  return result;
}

export function activeLease(leases: Lease[], resource: string, slot: number, tick: number) {
  return leases.find((lease) => lease.resource === resource && lease.slot === slot && lease.start <= tick && tick < lease.end);
}

export function truckPose(lease: Lease | undefined, tick: number, park: Point, dock: Point) {
  if (!lease) return { position: park, moving: false, unloading: false, phase: 'стоянка', travel: 0 };
  const p = progress(lease, tick);
  if (p < 0.28) return { position: lerpPoint(park, dock, p / 0.28), moving: true, unloading: false, phase: 'въезд', travel: p / 0.28 };
  if (p < 0.72) return { position: dock, moving: false, unloading: true, phase: 'разгрузка', travel: 1 };
  return { position: lerpPoint(dock, park, (p - 0.72) / 0.28), moving: true, unloading: false, phase: 'выезд', travel: (1 - p) / 0.28 };
}

function polar(a: Point, b: Point, mast: Point, t: number): Point {
  const from = Math.atan2(a[2] - mast[2], a[0] - mast[0]);
  const to = Math.atan2(b[2] - mast[2], b[0] - mast[0]);
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  const radiusA = Math.hypot(a[0] - mast[0], a[2] - mast[2]);
  const radiusB = Math.hypot(b[0] - mast[0], b[2] - mast[2]);
  const radius = radiusA + (radiusB - radiusA) * smooth(t);
  const angle = from + delta * smooth(t);
  return [mast[0] + Math.cos(angle) * radius, a[1] + (b[1] - a[1]) * smooth(t), mast[2] + Math.sin(angle) * radius];
}

/** Empty hook / pickup / lift / slew / guarded lowering / handoff / empty hoist. */
export function liftPose(p: number, mast: Point, pickup: Point, destination: Point, previous: Point, transitY: number, cargoHalfHeight: number) {
  const highSource: Point = [pickup[0], transitY, pickup[2]];
  const highTarget: Point = [destination[0], transitY, destination[2]];
  const preDock: Point = [destination[0], destination[1] + cargoHalfHeight * 2 + 0.18, destination[2]];
  let position: Point, hook: Point, loadVisible = true, attached = false, opacity = 1, phase: string;
  if (p < 0.12) { position = pickup; hook = polar(previous, highSource, mast, p / 0.12); phase = 'подача крюка'; }
  else if (p < 0.22) { position = pickup; hook = lerpPoint(highSource, pickup, (p - 0.12) / 0.10); phase = 'строповка'; }
  else if (p < 0.28) { position = pickup; hook = pickup; phase = 'строповка'; }
  else if (p < 0.42) { position = lerpPoint(pickup, highSource, (p - 0.28) / 0.14); hook = position; attached = true; phase = 'подъём'; }
  else if (p < 0.68) { position = polar(highSource, highTarget, mast, (p - 0.42) / 0.26); hook = position; attached = true; phase = 'перенос'; }
  else if (p < 0.84) { position = lerpPoint(highTarget, preDock, (p - 0.68) / 0.16); hook = position; attached = true; phase = 'подача к месту монтажа'; }
  else if (p < 0.90) { position = preDock; hook = preDock; attached = true; opacity = 1 - (p - 0.84) / 0.06; phase = 'передача монтажникам'; }
  else { position = preDock; hook = lerpPoint(preDock, highTarget, (p - 0.90) / 0.10); loadVisible = false; phase = 'подъём пустого крюка'; }
  return { position, hook, phase, attached, loadVisible, opacity, installed: p >= 0.90 };
}
