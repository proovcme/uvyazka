/** Projection of the kernel's immutable event log. Does not make scheduling decisions. */
export interface Operation {
  id: string; unit_id?: string; name: string; kind: string; duration: number;
  target_ids: string[]; demands: Record<string, number>; dependencies: string[];
  visual_phase: 'none' | 'work'; evidence: { kind: string; reason: string; basis: string };
}
export interface Scenario {
  id: string; name: string; model_id: string; seed: number;
  operations: Operation[];
  resources: { id: string; name: string; capacity: number }[];
  units: { id: string; name: string; target_ids: string[]; operation_ids: string[]; technology_status: string }[];
  assumptions: string[]; unplanned_element_ids: string[];
}
export interface SimulationEvent {
  sequence: number; time: number; kind: string; operation_id: string | null;
  resource_id?: string; used?: number; resource_ids?: string[];
}
export interface RunPackage {
  contract: 'RunPackage'; contract_version: '0.1.0'; run_id: string;
  manifest: { engine_version: string; scenario_sha256: string; model_id: string; seed: number; tick_unit: string };
  scenario: Scenario; events: SimulationEvent[];
  operation_states: Record<string, { status: string; start: number; finish: number }>;
  duration: number; status: string;
}
export function projectState(run: RunPackage, tick: number) {
  const states = new Map<string, string>();
  const resources = new Map(run.scenario.resources.map((resource) => [resource.id, 0]));
  for (const event of run.events) {
    if (event.time > tick) break;
    if (event.kind === 'operation_ready') states.set(event.operation_id!, 'ready');
    if (event.kind === 'resource_wait') states.set(event.operation_id!, 'waiting');
    if (event.kind === 'operation_started') states.set(event.operation_id!, 'running');
    if (event.kind === 'operation_completed') states.set(event.operation_id!, 'completed');
    if (event.resource_id && event.used !== undefined) resources.set(event.resource_id, event.used);
  }
  const active = run.scenario.operations.filter((operation) => states.get(operation.id) === 'running');
  const waiting = run.scenario.operations.filter((operation) => states.get(operation.id) === 'waiting');
  const completed = [...states.values()].filter((state) => state === 'completed').length;
  const construction = new Map<string, 'future' | 'active' | 'complete'>();
  const operations = new Map(run.scenario.operations.map((operation) => [operation.id, operation]));
  for (const unit of run.scenario.units) {
    const complete = unit.operation_ids.length > 0 && unit.operation_ids.every(id => states.get(id) === 'completed');
    const started = unit.operation_ids.some((id) => {
      const operation = operations.get(id)!;
      return operation.visual_phase === 'work' && ['running', 'completed'].includes(states.get(id) ?? '');
    });
    for (const id of unit.target_ids) construction.set(id, complete ? 'complete' : started ? 'active' : 'future');
  }
  return { states, resources, active, waiting, completed, construction };
}

/** Presentation clock only: rate and pauses never change the event log. */
export class PlaybackClock {
  time = 0;
  playing = false;
  rate = 60;
  constructor(readonly duration: number) {}
  seek(tick: number) { this.time = Math.min(this.duration, Math.max(0, tick)); }
  advance(realSeconds: number) {
    if (this.playing) this.seek(this.time + Math.max(0, realSeconds) * this.rate);
    if (this.time >= this.duration) this.playing = false;
    return this.time;
  }
}
