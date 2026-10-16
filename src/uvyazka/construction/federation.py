"""Federated view packages: immutable sources, explicit rigid placements, scoped IDs."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

import numpy as np

from .importer import write_json, CONTRACT_VERSION

FEDERATION_VERSION = '0.1.0'


def placement(member):
    offset = member.get('offset_m', [0, 0, 0])
    angle = member.get('rotation_deg', 0)
    if (not isinstance(offset, list) or len(offset) != 3 or
            any(type(x) not in (int, float) or not np.isfinite(x) for x in offset) or
            type(angle) not in (int, float) or not np.isfinite(angle)):
        raise ValueError('Размещение модели: конечные X/Y/Z в метрах и угол вокруг Z в градусах')
    a = np.radians(angle)
    rotation = np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])
    return rotation, np.array(offset, dtype=float)


def create_federation(cache, members):
    cache = Path(cache)
    if not isinstance(members, list) or not 1 <= len(members) <= 32:
        raise ValueError('Нужно от 1 до 32 моделей')
    records, packages, instance_ids = [], [], set()
    for index, member in enumerate(members):
        if not isinstance(member, dict) or set(member) - {'model_id', 'instance_id', 'label', 'offset_m', 'rotation_deg'}:
            raise ValueError('Неизвестные параметры включения модели')
        model_id = member.get('model_id', '')
        instance = member.get('instance_id', f'model-{index + 1}')
        if not re.fullmatch('[a-f0-9]{64}', model_id) or not re.fullmatch('[a-zA-Z0-9_-]{1,64}', instance):
            raise ValueError('Неверный model_id или instance_id')
        if instance in instance_ids:
            raise ValueError('Каждый экземпляр модели должен иметь уникальный instance_id')
        instance_ids.add(instance)
        directory = cache / 'models' / model_id
        if not (directory / 'manifest.json').is_file() or not (directory / 'geometry.bin').is_file():
            raise ValueError('Сначала импортируйте каждую модель')
        content = (directory / 'manifest.json').read_bytes()
        model = json.loads(content)
        if model.get('federation'):
            raise ValueError('Передайте исходные модели сводной сцены, без вложенных федераций')
        placement(member)
        records.append({'model_id': model_id, 'instance_id': instance,
            'label': str(member.get('label') or model['source']['filename'])[:180],
            'offset_m': member.get('offset_m', [0, 0, 0]), 'rotation_deg': member.get('rotation_deg', 0),
            'manifest_sha256': hashlib.sha256(content).hexdigest(),
            'coordinate_basis': 'source_world_coordinates_plus_explicit_rigid_placement',
            'coordinate_alignment_verified': False})
        packages.append((model, directory))
    digest = hashlib.sha256(json.dumps({'version': FEDERATION_VERSION, 'members': records}, sort_keys=True).encode()).hexdigest()
    target = cache / 'models' / digest
    target.mkdir(parents=True, exist_ok=True)
    if (target / 'manifest.json').is_file() and (target / 'geometry.bin').is_file():
        return {'model_id': digest, 'members': records, 'statistics': json.loads((target / 'manifest.json').read_text(encoding='utf8'))['statistics']}
    rows, meshes, storeys, relationships, diagnostics, phase_sources = [], [], [], [], [], {}
    for member, (model, directory) in zip(records, packages):
        prefix = member['instance_id'] + ':'
        remap = lambda key: prefix + str(key) if key is not None else None
        rotation, offset = placement(member)
        data = (directory / 'geometry.bin').read_bytes()
        origin = np.array(model['coordinate_system']['render_origin_m'])
        phase_sources[member['instance_id']] = deepcopy(model.get('revit', {'status': 'unavailable', 'phases': []}))
        for source in model['elements']:
            row = deepcopy(source)
            row.update({'id': remap(source['id']), 'storey_id': remap(source['storey_id']),
                'source_model_id': member['model_id'], 'source_instance_id': member['instance_id'],
                'source_element_id': source['id'], 'source_step_id': source['step_id']})
            if row.get('mesh'):
                mesh = row['mesh']
                vertices = np.frombuffer(data, dtype='<f4', count=mesh['vertex_count'] * 3,
                    offset=mesh['position_byte_offset']).reshape(-1, 3).astype(float)
                vertices = (vertices + origin) @ rotation.T + offset
                indices = np.frombuffer(data, dtype='<u4', count=mesh['index_count'], offset=mesh['index_byte_offset'])
                mesh['bbox_min_m'], mesh['bbox_max_m'] = vertices.min(axis=0).tolist(), vertices.max(axis=0).tolist()
                meshes.append((row, vertices, indices))
            rows.append(row)
        for source in model['storeys']:
            row = deepcopy(source)
            row.update({'id': remap(source['id']), 'source_instance_id': member['instance_id'],
                'name': member['label'] + ' · ' + source['name'],
                'elevation_m': source['elevation_m'] + offset[2] if source['elevation_m'] is not None else None})
            if row.get('placement_origin_m') is not None:
                row['placement_origin_m'] = (np.array(row['placement_origin_m']) @ rotation.T + offset).tolist()
            storeys.append(row)
        relationships.extend([{**deepcopy(r), 'parent_id': remap(r['parent_id']), 'child_ids': [remap(k) for k in r['child_ids']],
            'source_instance_id': member['instance_id']} for r in model['relationships']])
        diagnostics.extend([{**deepcopy(d), 'element_id': remap(d['element_id'])} for d in model['diagnostics']])
    physical = [r for r in rows if r['mesh'] and r['role'] == 'element']
    bounded = physical or [r for r in rows if r['mesh']]
    if not bounded:
        raise ValueError('В сводной сцене нет геометрии')
    lower = np.min([r['mesh']['bbox_min_m'] for r in bounded], axis=0)
    upper = np.max([r['mesh']['bbox_max_m'] for r in bounded], axis=0)
    origin = np.array([(lower[0]+upper[0])/2, (lower[1]+upper[1])/2, lower[2]])
    with (target / 'geometry.bin').open('wb') as stream:
        for row, vertices, indices in meshes:
            row['mesh']['position_byte_offset'] = stream.tell()
            stream.write(np.asarray(vertices - origin, dtype='<f4').tobytes())
            row['mesh']['index_byte_offset'] = stream.tell()
            stream.write(indices.tobytes())
    statistics = {'products': len(rows), 'physical_elements': sum(r['role'] == 'element' for r in rows),
        'meshes': len(meshes), 'triangles': sum(len(indices)//3 for _, _, indices in meshes),
        'geometry_errors': sum(bool(r.get('geometry_error')) for r in rows),
        'binary_bytes': (target / 'geometry.bin').stat().st_size}
    result = {'contract': 'ModelPackage', 'contract_version': CONTRACT_VERSION,
        'importer_version': 'federation-' + FEDERATION_VERSION, 'model_id': digest,
        'source': {'filename': f'Сводная модель · {len(records)} раздела', 'format': 'federation', 'sha256': digest,
            'size_bytes': sum(m['source']['size_bytes'] for m, _ in packages),
            'schema': ' + '.join(sorted({m['source']['schema'] for m, _ in packages})), 'exported_at': '', 'exporter': 'IFCCS federation'},
        'federation': {'version': FEDERATION_VERSION, 'members': records,
            'note': 'Исходные координаты сохранены; совпадение общих координат и связей Revit автоматически не подтверждено.'},
        'phase_sources': phase_sources, 'coordinate_system': {'length_to_m': 1, 'render_origin_m': origin.tolist(),
            'up_axis': 'Z', 'bounds_min_m': lower.tolist(), 'bounds_max_m': upper.tolist()},
        'storeys': storeys, 'elements': rows, 'relationships': relationships, 'diagnostics': diagnostics,
        'statistics': statistics, 'capabilities': {'read': True, 'geometry_ready': True, 'technology_resolved': False, 'schedule_ready': False}}
    write_json(target / 'manifest.json', result)
    return {'model_id': digest, 'members': records, 'statistics': statistics}
