import type { Point } from './site-motion';

/** Visual envelope, not a rated machine or a lifting calculation. */
export const MOBILE_CRANE = {
  type: 'mobile_crane', name: 'Компактный автокран',
  retractedLength: 6.2, maxBoomLength: 28, pivotHeight: 2.2,
  outriggerWidth: 6.5, evidence: 'simulation_assumption',
  loadMassKg: null, ratedCapacityKg: null,
  reason: 'Предварительный тип для малоэтажной демонстрации; масса груза, грузовая характеристика и грунт не подтверждены.',
} as const;

export interface Obstacle { min: Point; max: Point }

/** Required tip height keeps the straight boom above intersected occupied AABBs. */
export function mobileCraneRig(pivot: Point, hook: Point, obstacles: Obstacle[] = [], clearance = .6) {
  const dx = hook[0] - pivot[0], dz = hook[2] - pivot[2];
  const radius = Math.hypot(dx, dz);
  let tipY = Math.max(pivot[1] + 1.3, hook[1] + .8);
  for (const box of obstacles) {
    let entry = 0, exit = 1;
    for (const axis of [0, 2] as const) {
      const delta = hook[axis] - pivot[axis];
      if (Math.abs(delta) < 1e-9) {
        if (pivot[axis] < box.min[axis] - .35 || pivot[axis] > box.max[axis] + .35) { exit = -1; break; }
      } else {
        const a = (box.min[axis] - .35 - pivot[axis]) / delta;
        const b = (box.max[axis] + .35 - pivot[axis]) / delta;
        entry = Math.max(entry, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (entry > exit || exit < 0 || entry > 1) continue;
    // A crane pivot inside an obstacle has no valid boom route.
    if (entry < 1e-6 && box.max[1] + clearance >= pivot[1]) return { head: hook, radius, angle: 0, length: Infinity, reachable: false };
    if (entry > 1e-6) tipY = Math.max(tipY, pivot[1] + (box.max[1] + clearance - pivot[1]) / entry);
  }
  let rise = tipY - pivot[1];
  let length = Math.hypot(radius, rise);
  if (length < MOBILE_CRANE.retractedLength) {
    rise = Math.sqrt(MOBILE_CRANE.retractedLength ** 2 - radius ** 2);
    tipY = pivot[1] + rise; length = MOBILE_CRANE.retractedLength;
  }
  return { head: [hook[0], tipY, hook[2]] as Point, radius, angle: Math.atan2(rise, radius), length,
    reachable: length <= MOBILE_CRANE.maxBoomLength };
}
