import type { Lease } from './site-motion';

/** Reproducible task cycles sampled from virtual time; no independent wall clock. */
export function workerMotion(lease: Lease | undefined, tick: number, member: number, canWalk: boolean, fallback: boolean) {
  if (!lease || fallback) return {travel:0,walk:0,arm:0,lean:0,action:lease?'ожидание доступа':'ожидание назначения'};
  const duration = Math.max(.001,lease.end-lease.start), p=(tick-lease.start)/duration;
  const cycle = p*Math.max(4,duration/24)+member*.31;
  const phase = cycle-Math.floor(cycle), walking=canWalk && phase<.4;
  const travel=walking ? (1-Math.cos(phase/.4*Math.PI*2))/2 : 0;
  const swing=Math.sin(cycle*Math.PI*12);
  const inspection=/inspect|survey|commission|check/.test(lease.resource+' '+lease.operation.kind);
  const concrete=/concrete|concreting|formwork|reinforc/.test(lease.resource+' '+lease.operation.kind);
  return {travel,walk:walking?swing*.48:0,arm:walking?swing*.4:inspection?-.8+Math.sin(cycle*12)*.18:-.85+Math.sin(cycle*20)*.55,
    lean:walking?0:inspection?.05:.12+(1+Math.sin(cycle*20))*.10,
    action:walking?'перемещение у фронта':inspection?'осмотр и замер':concrete?'работа с бетоном / опалубкой':'монтаж'};
}
