"""IFC-class based MEP work, with explicit unknown topology and assumed productivity."""
from .quantities import quantity
from .production import make_operation

MEP_FAMILIES = ('IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment', 'IfcCableSegment',
    'IfcDuctFitting', 'IfcPipeFitting', 'IfcCableCarrierFitting', 'IfcAirTerminal', 'IfcSanitaryTerminal',
    'IfcLightFixture', 'IfcElectricDistributionBoard', 'IfcFlowSegment', 'IfcFlowFitting',
    'IfcFlowTerminal', 'IfcFlowController', 'IfcFlowMovingDevice', 'IfcFlowTreatmentDevice',
    'IfcFlowStorageDevice', 'IfcEnergyConversionDevice', 'IfcDistributionControlElement')


def technology(element, family):
    if family not in MEP_FAMILIES:
        return None
    chain = element['hierarchy']
    electrical = any(k in chain for k in ('IfcCableSegment', 'IfcCableCarrierSegment', 'IfcCableCarrierFitting',
        'IfcLightFixture', 'IfcElectricDistributionBoard', 'IfcElectricAppliance', 'IfcOutlet'))
    pipe = any(k in chain for k in ('IfcPipeSegment', 'IfcPipeFitting', 'IfcSanitaryTerminal', 'IfcValve', 'IfcPump'))
    discipline = 'electrical' if electrical else 'pipe' if pipe else 'hvac'
    role = 'segment' if 'IfcFlowSegment' in chain else 'fitting' if 'IfcFlowFitting' in chain else 'terminal' if 'IfcFlowTerminal' in chain else 'equipment'
    return f'mep_{discipline}_{role}', discipline, role


def templates(unit):
    crew = {'hvac': 'hvac_crew', 'pipe': 'pipe_crew', 'electrical': 'electrical_crew'}[unit['mep_discipline']]
    role = unit['mep_role']
    kind = {'hvac': 'duct_install', 'pipe': 'pipe_install', 'electrical': 'cable_install'}[unit['mep_discipline']] if role == 'segment' else 'mep_' + role
    return [('mep_delivery', 'Доставка инженерных элементов', {'truck': 1}, 'none'),
        ('mep_supports', 'Монтаж креплений · схема и шаг приняты', {crew: 1}, 'work'),
        (kind, {'segment': 'Монтаж участка сети', 'fitting': 'Монтаж фасонной части', 'terminal': 'Установка конечного устройства',
            'equipment': 'Монтаж инженерного оборудования'}[role], {crew: 1}, 'work'),
        ('mep_check', 'Условный контроль монтажа · без протокола испытаний', {'commissioning_crew': 1}, 'work')]


def work(unit, kind, profile):
    if kind == 'mep_check':
        return quantity(1, 'check', 'assumed', 'synthetic_mep_inspection')
    if kind == 'mep_delivery':
        return unit['quantities']['count']
    length = unit['quantities']['length']
    if kind == 'mep_supports':
        import math
        count = max(2, math.ceil(length['value'] / profile['parameters']['hanger_spacing_m']) + 1) if length['value'] > 0 else 2
        return quantity(count, 'piece', 'assumed', 'assumed_hanger_spacing_not_design',
            spacing_m=profile['parameters']['hanger_spacing_m'], source_length=length, requires_engineering_check=True)
    if unit['mep_role'] == 'segment':
        if length['value'] > 0:
            return length
        return {**unit['quantities']['count'], 'kind': 'assumed', 'method': 'piece_count_fallback_missing_quantity',
            'requires_review': True, 'missing_quantity': length}
    return unit['quantities']['count']


def finish_systems(model, units, operations, profile):
    groups = {}
    for unit in units:
        if unit.get('construction_role') != 'mep':
            continue
        key = unit.get('source_instance_id', 'model') + ':' + unit['mep_discipline'] + ':unassigned'
        groups.setdefault(key, []).append(unit)
    packages = []
    for index, (key, members) in enumerate(sorted(groups.items())):
        operation = make_operation(f'mep-system:{index}:commissioning', 'Проверка и наладка сети · условный сценарий',
            'commissioning', quantity(1, 'check', 'assumed', 'synthetic_unassigned_network_commissioning'),
            {'commissioning_crew': 1}, profile, [u['operation_ids'][-1] for u in members], package_id='mep_commissioning')
        operations.append(operation)
        packages.append({'id': key, 'unit_ids': [u['id'] for u in members], 'operation_id': operation['id'],
            'grouping_basis': 'assumed_source_model_and_IFC_discipline', 'connectivity_verified': False,
            'unresolved': ['Топология и принадлежность систем', 'Изоляция/огнезащита и проходки',
                'Проект креплений', 'Режимы испытаний и измеренные параметры ПНР']})
    return packages
