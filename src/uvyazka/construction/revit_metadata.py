"""Schema-directed saved RVT phases; no guesses from names, IDs or byte searches."""
import json
import os
from pathlib import Path
import subprocess

from .rvt_runtime import binary_path

METADATA_VERSION = '0.1.0'


def reader_path():
    return binary_path('ifccs-rvt-metadata')


def native_id(value):
    if isinstance(value, int):
        return str(value) if value >= 0 else None
    if isinstance(value, dict):
        for key in ('m_id64', 'm_id'):
            if key in value:
                return native_id(value[key])
    return None


def phase_projection(native):
    records = [r for r in native['records'] if r.get('root_fields') and r['status'] == 'complete_bounded_graph']
    catalog = {str(r['identity']['element_id']): r for r in records if r['class_name'] == 'ProjectPhase'}
    orders = [[native_id(x) for x in r['root_fields'].get('m_phaseIds', [])]
        for r in records if r['class_name'] == 'AllProjectPhases']
    order = orders[0] if len(orders) == 1 and all(x in catalog for x in orders[0]) else []
    phases = [{'id': key, 'name': r['root_fields'].get('m_name'), 'order': order.index(key) if key in order else None,
        'source': {'kind': 'explicit', 'method': 'rvt_native_schema_graph', 'field': 'ProjectPhase.m_name',
            'record_body_sha256': r['source']['body_sha256']}} for key, r in catalog.items()]
    phases.sort(key=lambda p: (p['order'] is None, p['order'] or 0, p['id']))
    elements = {}
    for r in records:
        f = r['root_fields']
        key = str(r['identity']['element_id'])
        if r['class_name'] in ('ProjectPhase', 'AllProjectPhases'):
            continue
        elements[key] = {'element_id': key, 'unique_id': r['identity'].get('unique_id'),
            'phase_created_id': native_id(f.get('m_createdPhaseId')),
            'phase_demolished_id': native_id(f.get('m_demolishedPhaseId')),
            'phase_status': 'read' if 'm_createdPhaseId' in f and 'm_demolishedPhaseId' in f else 'unavailable',
            'source': {'kind': 'explicit', 'method': 'rvt_native_schema_graph', 'value_semantics': 'serialized_not_evaluated',
                'record_body_sha256': r['source']['body_sha256'], 'stream': r['source']['stream']}}
    return {'version': METADATA_VERSION, 'status': 'read' if phases and order else 'partial',
        'phases': phases, 'phase_order_known': bool(order), 'elements': elements,
        'coordinate_status': 'shared_coordinates_and_link_transforms_unverified',
        'note': 'Сохранённые поля RVT, прочитанные по схеме; не вычисленные API значения. Фазы разных документов не отождествляются по имени.'}


def read_revit_metadata(source, package, model):
    from .importer import write_json
    binary = reader_path()
    if not binary.is_file():
        return {'status': 'unavailable', 'phases': [], 'phase_order_known': False,
            'note': 'Установите локальный reader стадий: uv run python tools/setup_rvt.py'}
    ids = sorted({int(e['revit']['element_id']) for e in model['elements'] if e.get('revit', {}).get('element_id')})
    ids_path, output = Path(package) / 'native-request-ids.json', Path(package) / 'revit-native.json'
    write_json(ids_path, ids)
    try:
        result = subprocess.run([str(binary), str(Path(source).resolve()), str(ids_path.resolve()), str(output.resolve())],
            capture_output=True, text=True, encoding='utf8', errors='replace', timeout=180)
        if result.returncode:
            return {'status': 'unavailable', 'phases': [], 'phase_order_known': False, 'note': result.stderr[-1000:]}
        native = json.loads(output.read_text(encoding='utf8'))
        projected = phase_projection(native)
        for element in model['elements']:
            key = element.get('revit', {}).get('element_id')
            if key in projected['elements']:
                element['revit'] = projected['elements'][key]
        projected['matched_elements'] = sum(e.get('revit', {}).get('phase_status') == 'read' for e in model['elements'])
        projected.pop('elements')
        return projected
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {'status': 'unavailable', 'phases': [], 'phase_order_known': False, 'note': str(error)[:1000]}


def phase_context(model, selections=None):
    sources = model.get('phase_sources') or {'model': model.get('revit', {})}
    selections = selections or {}
    if not isinstance(selections, dict) or set(selections) - set(sources):
        raise ValueError('Неизвестная модель в выборе стадий Revit')
    contexts = {}
    for key, source in sources.items():
        phases = source.get('phases', [])
        order = {p['id']: p['order'] for p in phases if p.get('order') is not None}
        selected = selections.get(key)
        if selected is None and order:
            selected = max(order, key=order.get)
        if selected not in (None, 'all') and selected not in order:
            raise ValueError('Выбранная стадия не имеет подтверждённого порядка в исходной модели')
        contexts[key] = {'selected_id': selected, 'order': order,
            'source_status': source.get('status', 'unavailable')}
    return contexts


def phase_status(element, contexts):
    context = contexts.get(element.get('source_instance_id', 'model'), {})
    selected = context.get('selected_id')
    phases = context.get('order', {})
    data = element.get('revit', {})
    created, demolished = data.get('phase_created_id'), data.get('phase_demolished_id')
    if selected in (None, 'all') or data.get('phase_status') != 'read' or created not in phases:
        return 'unknown'
    rank = phases[selected]
    if phases[created] > rank:
        return 'future'
    if demolished is not None and demolished not in phases:
        return 'unknown'
    if demolished is not None and phases[demolished] < rank:
        return 'absent'
    if demolished == selected:
        return 'temporary' if created == selected else 'demolition'
    return 'new' if created == selected else 'existing'
