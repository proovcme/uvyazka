import type { RunPackage } from './simulation';

export type TimelineUnit = 'minutes' | 'hours' | 'days';
export const timeLabel = (minutes:number, unit:TimelineUnit='days') => {
  const divisor=unit==='days'?1440:unit==='hours'?60:1;
  return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(minutes/divisor);
};
/** Read-only projection: no invented dates, no inferred start/finish for unscheduled work. */
export function timelineRows(run:RunPackage) {
  const known=new Set(run.scenario.operations.map(o=>o.id));
  const grouped=new Set<string>();
  const groups=run.scenario.units.map(unit=>({id:unit.id,name:unit.name,ids:unit.operation_ids.filter(id=>{
    if(!known.has(id)||grouped.has(id))return false;grouped.add(id);return true;
  })})).filter(g=>g.ids.length);
  for(const op of run.scenario.operations)if(!grouped.has(op.id))groups.push({id:op.id,name:op.name,ids:[op.id]});
  const operations=new Map(run.scenario.operations.map(o=>[o.id,o]));
  const span=Math.max(1,run.duration);
  return groups.map(g=>({...g,bars:g.ids.map(id=>{
    const op=operations.get(id)!;const state=run.operation_states[id];
    const scheduled=Number.isFinite(state?.start)&&Number.isFinite(state?.finish)&&state.start!==null&&state.finish!==null&&state.finish>=state.start;
    return {id,name:op.name,start:scheduled?state.start:null,finish:scheduled?state.finish:null,
      left:scheduled?Math.max(0,Math.min(100,state.start/span*100)):null,
      width:scheduled?Math.max(0,Math.min(span,state.finish-state.start)/span*100):null,
      evidence:op.evidence.kind};
  })}));
}
