"""Pure dependency timing shared by native and browser planning."""
def cpm(scenario: dict) -> dict:
    """FS-only longest path and floats without resource constraints/calendars."""
    ops = {o["id"]: o for o in scenario["operations"]}; remaining = set(ops); order = []; starts = {}; ends = {}
    while remaining:
        ready = sorted(k for k in remaining if all(p in ends for p in ops[k]["dependencies"]))
        if not ready:
            raise ValueError("Cycle in dependency graph")
        for key in ready:
            starts[key] = max((ends[p] for p in ops[key]["dependencies"]), default=0)
            ends[key] = starts[key] + ops[key]["duration"]; order.append(key); remaining.remove(key)
    duration = max(ends.values(), default=0); successors = {k: [] for k in ops}; latest = {}
    for key, op in ops.items():
        for parent in op["dependencies"]:
            successors[parent].append(key)
    for key in reversed(order):
        finish = min((latest[k] for k in successors[key]), default=duration)
        latest[key] = finish - ops[key]["duration"]
    return {"duration_minutes": duration, "scope": "Dependencies only; FS without lag, calendars or resource constraints",
        "operations": {k: {"early_start": starts[k], "early_finish": ends[k], "late_start": latest[k], "total_float": latest[k]-starts[k], "critical": latest[k] == starts[k]} for k in order}}
