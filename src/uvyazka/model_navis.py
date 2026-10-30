"""Addressed logical Navis nodes. Unknown property pages never become empty facts."""
from .model_readers import obj


def project_navis(models):
    rows, reports = [], []
    for mi, model in enumerate(models):
        namespace = model.get('namespace', '')
        tables = {}
        duplicates = set()
        for page, items in [(False, model.get('objects', [])), (True, model.get('property_objects', []))]:
            for item in items:
                key = (page, item.get('page_index') if page else None, item['serialized_id'])
                if key in tables:
                    duplicates.add(key)
                else:
                    tables[key] = item
        for key in duplicates:
            tables.pop(key, None)
        for node in model.get('nodes', []):
            props, evidence, unresolved = {}, [], []
            ids = {'namespace': namespace, 'node_index': node['index'], 'serialized_id': node['serialized_id'], 'native_guid': node.get('native_guid')}
            for ref in node.get('attributes', []):
                page = ref.get('page_index')
                def get(key):
                    return tables.get((page is not None, page, key), {})
                attribute = get(ref['serialized_id'])
                if not attribute:
                    unresolved.append(ref)
                    continue
                label = get(attribute.get('type_reference')).get('values', {})
                group = label.get('display') or label.get('internal') or 'class:'+str(attribute.get('serialized_class'))
                values = attribute.get('values', {})
                source = {**ref, 'record_offset': attribute.get('record_offset'), 'record_bytes': attribute.get('record_bytes'), 'category_internal': label.get('internal')}
                entries = []
                if attribute.get('serialized_class') == 86:
                    for prop in values.get('properties', []):
                        name = get(prop['name_reference']).get('values', {})
                        cell = prop.get('value', {})
                        value = cell.get('value')
                        if cell.get('tag') == 8 and isinstance(value, dict):
                            value = value.get('display') or value.get('internal') or value
                        entries.append((name.get('display') or name.get('internal') or str(prop['name_reference']), value, name.get('internal'), cell.get('tag')))
                elif attribute.get('serialized_class') == 66:
                    value = values.get('uint64_decimal')
                    if label.get('internal') == 'LcRevitId' and isinstance(value, str) and value.isdigit():
                        ids['element_id'] = value
                    entries.append((group, values.get('uint64_hex') if label.get('internal') == 'LcOpDwgEntityAttrib' else value, label.get('internal'), 'uint64_decimal'))
                elif attribute.get('serialized_class') == 70:
                    entries.append((group, values.get('string_value'), label.get('internal'), 'string'))
                else:
                    unresolved.append({'reference': ref, 'class': attribute.get('serialized_class')})
                for name, value, internal, tag in entries:
                    target = props.setdefault(str(group), {})
                    if name in target and target[name] != value:
                        previous = target[name]
                        target[name] = {'state': 'conflict', 'values': [previous, value]}
                    else:
                        target[name] = value
                    evidence.append({**source, 'field': name, 'parameter_internal': internal, 'value_tag': tag})
            rows.append(obj('elements', f'{mi}:{node["index"]}', node.get('name') or node.get('class_display'), node.get('class_name'), props,
                            identifiers=ids, parent=f'{mi}:{node["parent_index"]}' if node.get('parent_index') is not None else '',
                            semantic_kind='logical_node', quantity_eligible=False,
                            evidence={'stream': model.get('stream'), 'record_offset': node.get('record_offset'), 'record_bytes': node.get('record_bytes'), 'properties': evidence},
                            diagnostics={'unresolved_references': unresolved, 'unresolved_attribute_slots': node.get('unresolved_attribute_slots')},
                            value_semantics='own_saved_properties; inheritance not flattened; node is not a physical equipment count'))
        reports.append({k: model.get(k) for k in ('namespace', 'stream', 'status', 'diagnostic', 'declared_property_slots', 'decoded_property_slots', 'property_diagnostics', 'partition')})
    return rows, {'status': 'partial', 'models': reports, 'limitations': ['Logical hierarchy and own decoded properties only. Follow parent links explicitly for inheritance; no duplicated physical counts.', 'Geometry, TimeLiner, saved viewpoints, clash results and selection sets are not extracted by this metadata profile.']}
