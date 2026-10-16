"""Temporary access assets with explicit assembly/acceptance/use/removal dependencies."""
from .production import make_operation
from .quantities import quantity
from graphlib import TopologicalSorter


def access_packages(model, units, operations, profile, root_gate, tower_count):
    objects = {e['id']: e for e in model['elements']}
    by_id = {o['id']: o for o in operations}
    assets, facade_groups, elevated = [], {}, []
    threshold = profile['parameters']['height_access_threshold_m']
    floors = [e for e in model['elements'] if e.get('mesh') and 'IfcSlab' in e['hierarchy'] and e.get('predefined_type') != 'ROOF']
    envelopes = {}
    for unit in units:
        if unit['family']=='IfcWall':
            key=unit.get('source_instance_id','model')
            if key not in envelopes:envelopes[key]=[list(unit['lower']),list(unit['upper'])]
            else:
                envelopes[key]=[[min(envelopes[key][0][a],unit['lower'][a]) for a in range(3)],
                    [max(envelopes[key][1][a],unit['upper'][a]) for a in range(3)]]
    for unit in units:
        if unit['kind'] == 'demolition' or unit['family'] in ('IfcFooting', 'IfcSlab', 'IfcRoof', 'IfcStair'):
            continue
        candidates = [e['mesh']['bbox_max_m'][2] for e in floors
            if e['mesh']['bbox_max_m'][2] <= unit['lower'][2] + .15 and all(
                e['mesh']['bbox_min_m'][a] <= unit['upper'][a] and e['mesh']['bbox_max_m'][a] >= unit['lower'][a] for a in (0, 1))]
        base = max(candidates, default=profile['parameters']['ground_level_m'] or 0)
        if unit['upper'][2] - base <= threshold:
            continue
        source = objects[unit['id']]
        explicit_external=source.get('property_sets', {}).get('Pset_WallCommon', {}).get('IsExternal')
        external = unit['family'] == 'IfcWall' and explicit_external is True
        if unit['family']=='IfcWall' and explicit_external is None:
            envelope=envelopes[unit.get('source_instance_id','model')]
            dx,dy=unit['upper'][0]-unit['lower'][0],unit['upper'][1]-unit['lower'][1]
            axis=1 if dx>2*dy else 0 if dy>2*dx else None
            if axis is not None:
                center=(unit['lower'][axis]+unit['upper'][axis])/2
                tolerance=(unit['upper'][axis]-unit['lower'][axis])/2+.15
                external=min(abs(center-envelope[0][axis]),abs(center-envelope[1][axis]))<=tolerance
        if external:
            facade_groups.setdefault(unit.get('source_instance_id', 'model'), []).append(unit)
        else:
            elevated.append((unit, base))
    for index, (group, members) in enumerate(sorted(facade_groups.items())):
        lower = [min(u['lower'][a] for u in members) for a in range(3)]
        upper = [max(u['upper'][a] for u in members) for a in range(3)]
        area = max(1, 2 * (upper[0]-lower[0]+upper[1]-lower[1]) * (upper[2]-lower[2]))
        prefix = f'access:facade:{index}'
        work = quantity(area, 'm2', 'assumed', 'facade_envelope_scaffold_area', bounds=[lower, upper], requires_temporary_works_design=True)
        install = make_operation(prefix+':install', 'Монтаж фасадных лесов · предварительная схема', 'scaffold_install', work,
            {'scaffold_crew': 1}, profile, [root_gate], package_id='temporary_access')
        check = make_operation(prefix+':check', 'Условная приёмка лесов перед работой', 'access_check',
            quantity(1, 'check', 'assumed', 'synthetic_access_acceptance'), {'inspector': 1}, profile, [install['id']], package_id='temporary_access')
        work_ids = []
        for unit in members:
            first_work=next((by_id[key] for key in unit['operation_ids'] if by_id[key].get('visual_phase')=='work'),by_id[unit['operation_ids'][0]])
            first_work['dependencies'].append(check['id'])
            for oid in unit['operation_ids']:
                op = by_id[oid]
                if op['demands'] and op.get('visual_phase') == 'work':
                    op['demands']['scaffold_access'] = 1
                    op.setdefault('duration_basis', {}).setdefault('capacity_only_resources', []).append('scaffold_access')
                    work_ids.append(oid)
        remove = make_operation(prefix+':remove', 'Демонтаж фасадных лесов', 'scaffold_remove', work,
            {'scaffold_crew': 1}, profile, [u['operation_ids'][-1] for u in members], package_id='temporary_access')
        operations.extend([install, check, remove])
        assets.append({'id': prefix, 'kind': 'facade_scaffold', 'bounds_m': [lower, upper],
            'install_id': install['id'], 'check_id': check['id'], 'remove_id': remove['id'],
            'work_operation_ids': work_ids, 'source_instance_id': group,
            'selection_basis': 'explicit_IsExternal_or_assumed_outer_wall_envelope',
            'status': 'assumed', 'anchorage_verified': False, 'load_verified': False})
    # A lane is a complete access cycle. It cannot be reassigned between setup
    # and removal even when the generic resource pool is briefly released.
    order = list(TopologicalSorter({o['id']: o['dependencies'] for o in operations}).static_order())
    ranks = {key: i for i, key in enumerate(order)}
    elevated.sort(key=lambda pair: ranks[pair[0]['operation_ids'][-1]])
    previous_lane = {}
    for index, (unit, base) in enumerate(elevated):
        lane, prefix = index % tower_count, f'access:tower:{index}'
        first, last = by_id[unit['operation_ids'][0]], by_id[unit['operation_ids'][-1]]
        prerequisites = list(first['dependencies'])
        first_work=first
        if first['kind'] in ('delivery','mep_delivery') and len(unit['operation_ids'])>1:
            prerequisites.append(first['id'])
            first_work=by_id[unit['operation_ids'][1]]
        if lane in previous_lane:
            prerequisites.append(previous_lane[lane])
        setup = make_operation(prefix+':install', 'Сборка и установка вышки-туры', 'access_setup',
            quantity(1, 'piece', 'assumed', 'one_mobile_tower_per_work_cycle'), {'scaffold_crew': 1, 'access_tower': 1},
            profile, prerequisites, package_id='temporary_access')
        check = make_operation(prefix+':check', 'Условная приёмка вышки-туры', 'access_check',
            quantity(1, 'check', 'assumed', 'synthetic_access_acceptance'), {'inspector': 1, 'access_tower': 1},
            profile, [setup['id']], package_id='temporary_access')
        first_work['dependencies'].append(check['id'])
        work_ids = []
        for oid in unit['operation_ids']:
            operation = by_id[oid]
            if operation['demands'] and operation['kind'] not in ('delivery','mep_delivery'):
                operation['demands']['access_tower'] = 1
                operation.setdefault('duration_basis', {}).setdefault('capacity_only_resources', []).append('access_tower')
                work_ids.append(oid)
        remove = make_operation(prefix+':remove', 'Перестановка и разборка вышки-туры', 'access_remove',
            quantity(1, 'piece', 'assumed', 'one_mobile_tower_per_work_cycle'), {'scaffold_crew': 1, 'access_tower': 1},
            profile, [last['id']], package_id='temporary_access')
        operations.extend([setup, check, remove])
        previous_lane[lane] = remove['id']
        center = [(unit['lower'][a]+unit['upper'][a])/2 for a in range(3)]
        # The platform is a display proxy. Its stable placement is checked in
        # the viewer; this does not certify support, clearances or anchorage.
        height = max(1, unit['upper'][2] - base - 1.4)
        assets.append({'id': prefix, 'kind': 'access_tower', 'lane': lane, 'unit_id': unit['id'],
            'bounds_m': [[center[0]-.7, center[1]-.5, base], [center[0]+.7, center[1]+.5, base+height]],
            'install_id': setup['id'], 'check_id': check['id'], 'remove_id': remove['id'],
            'work_operation_ids': work_ids, 'status': 'assumed', 'support_verified': False, 'load_verified': False})
    return assets
