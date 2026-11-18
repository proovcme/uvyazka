"""Bounded engineering methods with typed inputs and visible intermediate results.

These kernels solve the declared mathematical cases. They do not select statutory
criteria, manufacture missing inputs or approve an engineering design.
"""
from decimal import Decimal, InvalidOperation
import math
import re

from .units import convert_value, resolve_unit

REVISION = 'engineering-methods-v1'
SKILL_REPOSITORY = 'https://github.com/proovcme/ru-aec-skills'
SKILL_REVISION = 'c88dedfaab63e836a72383a6552e94c6d9646334'

LABELS = {
    'standby_current':'Ток дежурного режима', 'alarm_current':'Ток тревожного режима',
    'standby_duration':'Длительность дежурного режима', 'alarm_duration':'Длительность тревожного режима',
    'load_voltage':'Напряжение нагрузки', 'battery_voltage':'Напряжение батареи',
    'battery_self_current':'Собственный ток со стороны батареи', 'efficiency':'КПД преобразования',
    'usable_fraction':'Доступная доля ёмкости', 'age_factor':'Коэффициент старения',
    'reference_level':'Опорный уровень звука', 'reference_distance':'Опорное расстояние',
    'distance':'Расстояние до расчётной точки', 'additional_loss':'Дополнительные потери звука',
    'input_power':'Входная активная мощность', 'voltage':'Напряжение', 'power_factor':'Коэффициент мощности',
    'phases':'Число фаз', 'current':'Ток', 'conductor_resistance':'Сопротивление одного проводника участка',
    'conductor_reactance':'Реактивное сопротивление одного проводника участка',
    'heat_power':'Тепловая мощность', 'specific_heat':'Удельная теплоёмкость',
    'temperature_difference':'Разность температур', 'density':'Плотность',
    'volume_flow':'Объёмный расход', 'inside_diameter':'Внутренний диаметр', 'length':'Длина участка',
    'darcy_friction_factor':'Коэффициент трения Дарси', 'local_loss_sum':'Сумма местных коэффициентов',
    'floor_area':'Площадь пола', 'height':'Высота зоны', 'open_area':'Площадь открытых проёмов',
    'required_ports':'Потребность в портах', 'available_ports':'Доступные порты',
    'reserve_of_required':'Доля резерва от потребности', 'minimum':'Минимальная освещённость',
    'mean':'Средняя освещённость', 'maximum':'Максимальная освещённость', 'total':'Суммарная нагрузка',
    'load_charge':'Заряд нагрузки', 'battery_side_charge':'Заряд со стороны батареи',
    'required_capacity':'Требуемая ёмкость', 'distance_loss':'Потери по расстоянию', 'level':'Уровень звука в точке',
    'sin_phi':'Синус угла сдвига фаз', 'voltage_drop':'Падение напряжения', 'drop_percent':'Относительное падение напряжения',
    'mass_flow':'Массовый расход', 'area':'Площадь сечения', 'velocity':'Скорость',
    'dynamic_pressure':'Динамическое давление', 'friction_loss':'Потери на трение', 'local_loss':'Местные потери',
    'pressure_loss':'Полные потери участка', 'fluid_head':'Потери напора данной жидкости', 'volume':'Объём зоны',
    'leakage_parameter':'Отношение площади проёмов к объёму', 'minimum_capacity':'Минимальная портовая ёмкость',
    'capacity_margin':'Остаток портовой ёмкости', 'minimum_to_mean':'Отношение минимальной освещённости к средней',
    'minimum_to_maximum':'Отношение минимальной освещённости к максимальной',
}


def spec(unit, minimum=None, maximum=None, positive=False):
    return dict(unit=unit, minimum=minimum, maximum=maximum, positive=positive)


METHODS = {
    'sum_products': dict(title='Сумма нагрузок по составу', fields={},
        collection='rows: 1–200 {quantity: scalar >=0, unit_value: {value,unit}}; common quantity kind',
        skills=['electrical-calculate-loads-and-circuits', 'fire-design-detection-and-automation'],
        limits='Only the supplied rows. Operating modes, completeness and simultaneity require review.'),
    'battery_charge': dict(title='Заряд батареи по двум режимам', fields={
        'standby_current': spec('A',0), 'alarm_current': spec('A',0),
        'standby_duration': spec('h',0), 'alarm_duration': spec('h',0),
        'load_voltage': spec('V',positive=True), 'battery_voltage': spec('V',positive=True),
        'battery_self_current': spec('A',0), 'efficiency': spec('1',maximum=1,positive=True),
        'usable_fraction': spec('1',maximum=1,positive=True), 'age_factor': spec('1',1)},
        skills=['fire-design-detection-and-automation'],
        limits='Self-current is on battery side. Supply duration, discharge curves, charging and battery compatibility are not inferred.'),
    'sound_level': dict(title='Уровень в точке прямого свободного поля', fields={
        'reference_level': spec('dBA'), 'reference_distance': spec('m',positive=True),
        'distance': spec('m',positive=True), 'additional_loss': spec('dB',0)},
        skills=['fire-design-detection-and-automation'],
        limits='One direct source with the same A weighting. No reflections, directivity, phase summation, barriers or intelligibility model.'),
    'electrical_current': dict(title='Ток по входной активной мощности', fields={
        'input_power': spec('W',0), 'voltage': spec('V',positive=True),
        'power_factor': spec('1',maximum=1,positive=True)}, enum={'phases':[1,3]},
        skills=['electrical-calculate-loads-and-circuits'],
        limits='Single phase or balanced sinusoidal three phase. Three-phase voltage is line-to-line; no second efficiency factor.'),
    'voltage_drop': dict(title='Падение напряжения одного участка', fields={
        'current': spec('A',0), 'voltage': spec('V',positive=True),
        'conductor_resistance': spec('ohm',0), 'conductor_reactance': spec('ohm',0),
        'power_factor': spec('1',maximum=1,positive=True)}, enum={'phases':[1,3]},
        skills=['electrical-calculate-loads-and-circuits'],
        limits='R/X are for one conductor over the entire section, not per kilometre. Lagging power factor; no harmonic/asymmetric or starting model.'),
    'liquid_heat_flow': dict(title='Расход теплоносителя по тепловому балансу', fields={
        'heat_power': spec('W',0), 'specific_heat': spec('J/(kg·K)',positive=True),
        'temperature_difference': spec('delta_K',positive=True), 'density': spec('kg/m3',positive=True)},
        skills=['hvac-design-hydronic-heating', 'plumbing-size-and-select-equipment'],
        limits='Constant supplied heat capacity and density for this case. No phase change, fluid-property lookup or automatic temperature schedule.'),
    'pipe_pressure_loss': dict(title='Потери давления участка по Дарси–Вейсбаху', fields={
        'volume_flow': spec('m3/s',0), 'inside_diameter': spec('m',positive=True),
        'length': spec('m',0), 'density': spec('kg/m3',positive=True),
        'darcy_friction_factor': spec('1',0), 'local_loss_sum': spec('1',0)},
        skills=['plumbing-size-and-select-equipment', 'hvac-design-hydronic-heating'],
        limits='Darcy (not Fanning) friction factor and local coefficients are explicitly supplied for the same velocity basis. No network solution or friction-regime selection.'),
    'enclosure_geometry': dict(title='Объём прямоугольной зоны и негерметичность', fields={
        'floor_area': spec('m2',positive=True), 'height': spec('m',positive=True), 'open_area': spec('m2',0)},
        skills=['fire-design-suppression'],
        limits='Geometric inputs only; excludes unprovided connected voids. Does not calculate agent mass, gas discharge or pressure relief.'),
    'port_budget': dict(title='Портовая ёмкость и явно заданный резерв', fields={
        'required_ports': spec('piece',0,1000000), 'available_ports': spec('piece',0,1000000), 'reserve_of_required': spec('1',0,100)},
        skills=['fire-electrical-issue-documentation'],
        limits='Reserve is a fraction of required ports. No traffic, uplink, PoE, address-space or redundancy calculation.'),
    'lighting_uniformity': dict(title='Равномерность по готовым значениям освещённости', fields={
        'minimum': spec('lx',0), 'mean': spec('lx',positive=True), 'maximum': spec('lx',positive=True)},
        skills=['electrical-design-lighting'],
        limits='Ratios from the same calculation surface. No photometric simulation, glare or automatic normative threshold.'),
}

RUSSIAN_LIMITS = {
    'sum_products':'Только переданные строки; полнота состава, режимы и одновременность проверяются отдельно.',
    'battery_charge':'Собственный ток задан со стороны батареи. Время автономии, разрядные кривые, заряд и совместимость батареи не определяются.',
    'sound_level':'Один прямой источник с одинаковой А-коррекцией. Отражения, направленность, суммирование источников и разборчивость речи не моделируются.',
    'electrical_current':'Однофазная либо симметричная синусоидальная трёхфазная нагрузка. Трёхфазное напряжение линейное; повторный КПД не вводится.',
    'voltage_drop':'R/X заданы для одного проводника на всю длину участка, не на километр. Отстающий ток; пуск, гармоники и несимметрия не моделируются.',
    'liquid_heat_flow':'Теплоёмкость и плотность заданы постоянными для данного режима. Свойства жидкости, фазовый переход и температурный график не определяются.',
    'pipe_pressure_loss':'Заданы коэффициент Дарси и местные коэффициенты для одной скорости. Сеть и режим трения автоматически не рассчитываются.',
    'enclosure_geometry':'Только заданная геометрия, без неуказанных связанных полостей. Масса вещества, выпуск газа и сброс давления не рассчитываются.',
    'port_budget':'Резерв задан долей от потребности. Трафик, магистраль, PoE, адресация и резервирование не рассчитываются.',
    'lighting_uniformity':'Отношения готовых значений одной поверхности. Фотометрия, слепимость и нормативный предел не определяются.',
}
for _method,_limits in RUSSIAN_LIMITS.items():
    METHODS[_method]['limits']=_limits


def scalar(value):
    if isinstance(value, bool) or not isinstance(value,(str,int,float)) or len(str(value))>80:
        raise ValueError('Expected a finite numeric scalar; missing and boolean values are not zero')
    try:
        number=Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError('Invalid numeric scalar') from exc
    if not number.is_finite() or abs(number)>Decimal('1e18') or (number and abs(number)<Decimal('1e-18')):
        raise ValueError('Numeric scalar outside finite supported magnitude 1e-18…1e18')
    return float(number)


def quantity(item, unit):
    if not isinstance(item,dict) or set(item)!={'value','unit'} or not isinstance(item['unit'],str):
        raise ValueError('Quantity needs exactly value and unit')
    value=scalar(item['value'])
    if unit in {'dBA','dB','1/m'}:
        if item['unit']!=unit:
            raise ValueError('Incompatible units: '+item['unit']+' / '+unit)
        return value
    return float(convert_value(Decimal(str(item['value'])),item['unit'],unit))


def output(value,unit):
    if not math.isfinite(value) or abs(value)>1e100:
        raise ValueError('Nonfinite or excessive calculation result')
    return {'value':format(value,'.17g'),'unit':unit}


def catalog():
    return {'revision':REVISION, 'methods':[
        {'method':name,**definition,'skill_sources':[
            SKILL_REPOSITORY+'/blob/'+SKILL_REVISION+'/'+skill+'/SKILL.md'
            for skill in definition['skills']]} for name,definition in METHODS.items()],
        'reported_results':'Map output name to {value,unit,tolerance:{value,unit}}. Tolerance is absolute and explicit.',
        'criteria':'Up to 40 {output,operator: <=|>=|==,value:{value,unit},basis}. Applicability and source of the criterion must be established by the caller.',
        'accepted':False}


def calculate(method,inputs,reported_results=None,criteria=None):
    if method not in METHODS:
        raise ValueError('Unsupported engineering method; read the method catalog')
    definition=METHODS[method]
    expected=set(definition['fields'])|set(definition.get('enum',{}))
    if method=='sum_products':expected={'rows'}
    if not isinstance(inputs,dict) or set(inputs)!=expected:
        raise ValueError('Provide exactly the declared inputs: '+', '.join(sorted(expected)))
    values={}
    for name,field in definition['fields'].items():
        value=quantity(inputs[name],field['unit'])
        if (not math.isfinite(value) or (field['positive'] and value<=0)
                or (field['minimum'] is not None and value<field['minimum'])
                or (field['maximum'] is not None and value>field['maximum'])):
            raise ValueError('Input outside declared domain: '+name)
        values[name]=value
    for name,options in definition.get('enum',{}).items():
        if type(inputs[name]) is not int or inputs[name] not in options:
            raise ValueError('Invalid '+name)
        values[name]=inputs[name]
    results={};trace=[]

    def step(name,formula,value,unit):
        item=output(value,unit)
        bindings={key:format(val,'.12g') for key,val in values.items()}
        bindings.update({key:format(float(val['value']),'.12g') for key,val in results.items()})
        aliases={'Istandby':'standby_current','Ialarm':'alarm_current','tstandby':'standby_duration',
                 'talarm':'alarm_duration','Uload':'load_voltage','Ubattery':'battery_voltage',
                 'Ibattery_self':'battery_self_current','Pinput':'input_power','U':'voltage',
                 'I':'current','R':'conductor_resistance','X':'conductor_reactance',
                 'Qheat':'heat_power','cp':'specific_heat','delta_T':'temperature_difference',
                 'Dinside':'inside_diameter','Darcy_lambda':'darcy_friction_factor'}
        bindings.update({alias:bindings[key] for alias,key in aliases.items() if key in bindings})
        bindings['pi']=format(math.pi,'.12g')
        if 'phases' in values:
            bindings['phase_factor']=format(math.sqrt(3) if values['phases']==3 else 2 if method=='voltage_drop' else 1,'.12g')
        substitution=re.sub(r'\b[A-Za-z_][A-Za-z_0-9]*\b',lambda match:bindings.get(match[0],match[0]),formula)
        results[name]=item;trace.append({'name':name,'formula':formula,'substitution':substitution,**item})
        return value

    v=values
    if method=='sum_products':
        rows=inputs['rows']
        if not isinstance(rows,list) or not 1<=len(rows)<=200:
            raise ValueError('Choose 1–200 explicit load rows')
        unit=None;terms=[]
        for i,row in enumerate(rows):
            if not isinstance(row,dict) or set(row)!={'quantity','unit_value'}:
                raise ValueError('A load row needs quantity and unit_value')
            count=scalar(row['quantity'])
            if count<0:raise ValueError('Negative load quantity')
            if unit is None:
                unit=row['unit_value'].get('unit') if isinstance(row['unit_value'],dict) else None
                if not resolve_unit(unit):raise ValueError('Unknown load unit')
            item=quantity(row['unit_value'],unit)
            if item<0:raise ValueError('Negative load')
            term=count*item;terms.append(term)
            trace.append({'name':f'row_{i+1}','formula':'quantity × unit_value',
                          'substitution':format(count,'.12g')+' × '+format(item,'.12g'),**output(term,unit)})
        step('total','sum(row products)',math.fsum(terms),unit)
    elif method=='battery_charge':
        charge=step('load_charge','Istandby × tstandby + Ialarm × talarm',
                    v['standby_current']*v['standby_duration']+v['alarm_current']*v['alarm_duration'],'Ah')
        battery=step('battery_side_charge','load_charge × Uload / (Ubattery × efficiency) + Ibattery_self × (tstandby + talarm)',
                     charge*v['load_voltage']/v['battery_voltage']/v['efficiency']
                     +v['battery_self_current']*(v['standby_duration']+v['alarm_duration']),'Ah')
        step('required_capacity','battery_side_charge × age_factor / usable_fraction',
             battery*v['age_factor']/v['usable_fraction'],'Ah')
    elif method=='sound_level':
        attenuation=step('distance_loss','20 × log10(distance / reference_distance)',
                         20*math.log10(v['distance']/v['reference_distance']),'dB')
        step('level','reference_level - distance_loss - additional_loss',
             v['reference_level']-attenuation-v['additional_loss'],'dBA')
    elif method=='electrical_current':
        factor=math.sqrt(3) if v['phases']==3 else 1
        step('current','Pinput / (phase_factor × U × power_factor)',
             v['input_power']/(factor*v['voltage']*v['power_factor']),'A')
    elif method=='voltage_drop':
        sine=step('sin_phi','sqrt(1 - power_factor²)',math.sqrt(1-v['power_factor']**2),'1')
        factor=math.sqrt(3) if v['phases']==3 else 2
        drop=step('voltage_drop','phase_factor × I × (R × power_factor + X × sin_phi)',
                  factor*v['current']*(v['conductor_resistance']*v['power_factor']+v['conductor_reactance']*sine),'V')
        step('drop_percent','100 × voltage_drop / U',100*drop/v['voltage'],'%')
    elif method=='liquid_heat_flow':
        mass=step('mass_flow','Qheat / (cp × delta_T)',v['heat_power']/v['specific_heat']/v['temperature_difference'],'kg/s')
        step('volume_flow','mass_flow / density',mass/v['density'],'m3/s')
    elif method=='pipe_pressure_loss':
        area=step('area','pi × Dinside² / 4',math.pi*v['inside_diameter']**2/4,'m2')
        velocity=step('velocity','volume_flow / area',v['volume_flow']/area,'m/s')
        dynamic=step('dynamic_pressure','density × velocity² / 2',v['density']*velocity**2/2,'Pa')
        friction=step('friction_loss','Darcy_lambda × length / Dinside × dynamic_pressure',
                      v['darcy_friction_factor']*v['length']/v['inside_diameter']*dynamic,'Pa')
        local=step('local_loss','local_loss_sum × dynamic_pressure',v['local_loss_sum']*dynamic,'Pa')
        loss=step('pressure_loss','friction_loss + local_loss',friction+local,'Pa')
        step('fluid_head','pressure_loss / (density × 9.80665)',loss/v['density']/9.80665,'m')
    elif method=='enclosure_geometry':
        volume=step('volume','floor_area × height',v['floor_area']*v['height'],'m3')
        step('leakage_parameter','open_area / volume',v['open_area']/volume,'1/m')
    elif method=='port_budget':
        if not v['required_ports'].is_integer() or not v['available_ports'].is_integer():
            raise ValueError('Ports must be whole counts')
        def exact_input(name,target):
            item=inputs[name]
            return convert_value(Decimal(str(item['value'])),item['unit'],target)
        needed=exact_input('required_ports','piece')*(1+exact_input('reserve_of_required','1'))
        required=step('minimum_capacity','ceil(required_ports × (1 + reserve_of_required))',
                      -(-needed.numerator//needed.denominator),'piece')
        step('capacity_margin','available_ports - minimum_capacity',v['available_ports']-required,'piece')
    elif method=='lighting_uniformity':
        if not v['minimum']<=v['mean']<=v['maximum']:
            raise ValueError('The same surface must satisfy minimum <= mean <= maximum')
        step('minimum_to_mean','minimum / mean',v['minimum']/v['mean'],'1')
        step('minimum_to_maximum','minimum / maximum',v['minimum']/v['maximum'],'1')

    comparisons=[]
    if reported_results is not None:
        if not isinstance(reported_results,dict) or len(reported_results)>40:
            raise ValueError('Provide at most 40 reported results')
        for name,reported in reported_results.items():
            if name not in results or not isinstance(reported,dict) or set(reported)!={'value','unit','tolerance'}:
                raise ValueError('Unknown output or incomplete reported result')
            unit=results[name]['unit'];actual=float(results[name]['value'])
            original=quantity({k:reported[k] for k in ('value','unit')},unit)
            tolerance=quantity(reported['tolerance'],unit)
            if tolerance<0:raise ValueError('Tolerance cannot be negative')
            difference=actual-original
            comparisons.append({'output':name,'reported':output(original,unit),'difference':output(difference,unit),
                                'tolerance':output(tolerance,unit),'status':'matches' if abs(difference)<=tolerance else 'differs'})
    checks=[]
    if criteria is not None:
        if not isinstance(criteria,list) or len(criteria)>40:raise ValueError('At most 40 criteria')
        for criterion in criteria:
            if not isinstance(criterion,dict) or set(criterion)!={'output','operator','value','basis'}:
                raise ValueError('A criterion needs output, operator, value and basis')
            name=criterion['output'];operator=criterion['operator'];basis=criterion['basis']
            if name not in results or operator not in {'<=','>=','=='} or not isinstance(basis,str) or not 1<=len(basis.strip())<=2000:
                raise ValueError('Invalid criterion or missing applicability basis')
            threshold=quantity(criterion['value'],results[name]['unit']);actual=float(results[name]['value'])
            passed=actual<=threshold if operator=='<=' else actual>=threshold if operator=='>=' else actual==threshold
            checks.append({**criterion,'status':'satisfied' if passed else 'not_satisfied'})
    return {'method':method,'method_revision':REVISION,'normalized_inputs':{
                k:output(x,definition['fields'][k]['unit']) if k in definition['fields'] else x for k,x in values.items()},
            'results':results,'trace':trace,'reported_comparisons':comparisons,'criteria_checks':checks,
            'criteria_applicability':'caller_supplied_not_approved','coverage':definition['limits'],
            'numerics':'finite binary floating-point to 17 significant digits; port rounding uses exact fractions; explicit tolerances required',
            'accepted':False}
