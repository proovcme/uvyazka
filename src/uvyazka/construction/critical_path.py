"""Pure dependency timing shared by native and browser planning."""
import heapq
def cpm(scenario: dict) -> dict:
    """FS-only longest path and floats without resource constraints/calendars."""
    ops = {o["id"]: o for o in scenario["operations"]}; order = []; starts = {}; ends = {}
    successors = {k: [] for k in ops}; remaining_parents = {}
    for key, op in ops.items():
        remaining_parents[key] = len(op['dependencies'])
        for parent in op["dependencies"]:
            if parent not in ops:raise ValueError('Unknown predecessor: '+str(parent))
            successors[parent].append(key)
    ready = [key for key,count in remaining_parents.items() if not count]; heapq.heapify(ready)
    while ready:
        key=heapq.heappop(ready)
        starts[key] = max((ends[parent] for parent in ops[key]['dependencies']),default=0)
        ends[key] = starts[key]+ops[key]['duration']; order.append(key)
        for child in successors[key]:
            remaining_parents[child]-=1
            if not remaining_parents[child]:heapq.heappush(ready,child)
    if len(order)!=len(ops):raise ValueError('Cycle in dependency graph')
    duration = max(ends.values(), default=0); latest = {}
    for key in reversed(order):
        finish = min((latest[k] for k in successors[key]), default=duration)
        latest[key] = finish - ops[key]["duration"]
    return {"duration_minutes": duration, "scope": "Dependencies only; FS without lag, calendars or resource constraints",
        "operations": {k: {"early_start": starts[k], "early_finish": ends[k], "late_start": latest[k], "total_float": latest[k]-starts[k], "critical": latest[k] == starts[k]} for k in order}}
