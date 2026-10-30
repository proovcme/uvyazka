"""Local format adapters. No model service, CAD application or cloud conversion.

Imports of optional libraries are deliberately inside the selected adapter.
The CAD subprocess is a separate GPL component; JSON is the process boundary.
"""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

from .core import digest, default_home

ROOT = Path(__file__).resolve().parents[2]
REVISION = 'model-data-v2'
SECTIONS = ('elements', 'types', 'systems', 'levels', 'layers', 'blocks', 'layouts', 'views', 'schedules', 'relationships')


def node_path():
    return shutil.which('node')


def module_available(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ModuleNotFoundError, ValueError):
        return False


def nwd_path(workspace):
    override = os.environ.get('UVYAZKA_NWD_READER')
    if override:
        return Path(override).expanduser().resolve()
    name = 'uvyazka-nwd-experiment' + ('.exe' if os.name == 'nt' else '')
    local = workspace.home/'tools'/'model-readers'/'nwd'/name
    return local if local.is_file() else default_home()/'tools'/'model-readers'/'nwd'/name


def cad_path():
    return Path(os.environ.get('UVYAZKA_CAD_READER') or ROOT/'integrations/cad-viewer/read-data.mjs').resolve()


def reader_status(workspace):
    from .construction.rvt_runtime import binary_path
    rvt = binary_path('ifccs-rvt-metadata')
    cad = cad_path()
    nwd = nwd_path(workspace)
    cad_deps = cad.parent/'node_modules/@mlightcad/libredwg-web/package.json'
    rows = {
        'rvt': {'available': rvt.is_file(), 'engine': 'rvt-rs/native', 'setup': 'python tools/setup_rvt.py', 'binary': rvt},
        'ifc': {'available': module_available('ifcopenshell'), 'engine': 'IfcOpenShell', 'setup': 'pip install "uvyazka[ifc]"'},
        'dxf': {'available': module_available('ezdxf'), 'engine': 'ezdxf', 'setup': 'pip install "uvyazka[authoring]"'},
        'dwg': {'available': bool(node_path() and cad.is_file() and cad_deps.is_file()), 'engine': 'LibreDWG/WASM separate GPL process', 'setup': 'npm ci --prefix integrations/cad-viewer', 'binary': cad},
        'nwd': {'available': nwd.is_file(), 'engine': 'uvyazka-nwd/native', 'setup': 'python tools/setup_model_readers.py --nwd', 'binary': nwd},
        'nwc': {'available': nwd.is_file(), 'engine': 'uvyazka-nwd/native', 'setup': 'python tools/setup_model_readers.py --nwd', 'binary': nwd},
    }
    for fmt, row in rows.items():
        binary = row.pop('binary', None)
        row['revision'] = digest(binary) if binary and binary.is_file() else REVISION
        if fmt == 'dwg' and cad_deps.is_file():
            row['revision'] += ':'+digest(cad_deps)
        if fmt in ('ifc', 'dxf') and row['available']:
            from importlib.metadata import version
            row['revision'] += ':'+version('ifcopenshell' if fmt == 'ifc' else 'ezdxf')
        row['scope'] = 'saved metadata; no evaluated application views or engineering approval'
    return {'contract': 'UvyazkaModelData', 'version': 1, 'readers': rows, 'sections': list(SECTIONS), 'geometry_vertices_returned': False, 'original_files_modified': False}


def obj(section, native_id, name='', category='', properties=None, **extra):
    return {'section': section, 'native_id': str(native_id), 'name': str(name or ''), 'category': str(category or ''), 'properties': properties or {}, **extra}


def json_value(value):
    """Preserve typed scalars and explicit references, never stringify opaque values as facts."""
    import math
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float:
        return value if math.isfinite(value) else {'state': 'nonfinite', 'representation': str(value)}
    if isinstance(value, dict):
        return {str(k): json_value(v) for k, v in value.items()}
    if hasattr(value, 'is_a') and hasattr(value, 'id'):
        return {'step_id': value.id(), 'class': value.is_a(), 'global_id': getattr(value, 'GlobalId', None)}
    if hasattr(value, 'xyz'):
        return list(value.xyz)
    if isinstance(value, (list, tuple)):
        return [json_value(v) for v in value]
    return {'state': 'unsupported_value', 'type': type(value).__name__}


def ifc_data(source):
    import ifcopenshell
    import ifcopenshell.util.element
    model = ifcopenshell.open(str(source))
    rows = []
    for element in model.by_type('IfcRoot'):
        cls = element.is_a()
        if element.is_a('IfcRelationship'):
            section = 'relationships'
        elif element.is_a('IfcSystem'):
            section = 'systems'
        elif element.is_a('IfcBuildingStorey'):
            section = 'levels'
        elif element.is_a('IfcTypeObject'):
            section = 'types'
        elif element.is_a('IfcProduct'):
            section = 'elements'
        else:
            continue
        info = element.get_info(recursive=False)
        def value(v):
            if isinstance(v, ifcopenshell.entity_instance):
                return {'step_id': v.id(), 'class': v.is_a(), 'global_id': getattr(v, 'GlobalId', None)}
            if isinstance(v, (tuple, list)):
                return [value(x) for x in v]
            return v
        info = {k: value(v) for k, v in info.items() if k != 'Representation'}
        props = ifcopenshell.util.element.get_psets(element, should_inherit=False) if section not in ('relationships', 'systems') else {}
        container = ifcopenshell.util.element.get_container(element, should_get_direct=True) if section == 'elements' else None
        rows.append(obj(section, element.id(), getattr(element, 'Name', ''), cls,
                        json_value({'attributes': info, 'property_sets': props}),
                        identifiers={'step_id': element.id(), 'global_id': getattr(element, 'GlobalId', None), 'tag': getattr(element, 'Tag', None)},
                        level=str(container.id()) if container else '',
                        evidence={'step_id': element.id(), 'schema': model.schema, 'property_path': ['properties']},
                        value_semantics='explicit_ifc; project units retained; geometry not measured'))
    units = [json_value(e.get_info(recursive=True)) for e in model.by_type('IfcUnitAssignment')]
    return rows, {'status': 'partial', 'schema': model.schema, 'units': units, 'limitations': ['IFC metadata only; no geometry validation, linked-file opening or engineering acceptance.', 'Property-set numbers retain IFC project units; Tag is not automatically a Revit ElementId.']}


def dxf_data(source):
    import ezdxf
    drawing = ezdxf.readfile(source)
    rows = []
    for layer in drawing.layers:
        rows.append(obj('layers', layer.dxf.handle, layer.dxf.name, 'LAYER', json_value(layer.dxf.all_existing_dxf_attribs()), identifiers={'handle': layer.dxf.handle}))
    for block in drawing.blocks:
        rows.append(obj('blocks', block.block_record_handle, block.name, 'BLOCK', {'name': block.name}, identifiers={'handle': block.block_record_handle}))
        for entity in block:
            attrs = entity.dxf.all_existing_dxf_attribs()
            for key, val in list(attrs.items()):
                if hasattr(val, 'xyz'):
                    attrs[key] = list(val.xyz)
            if entity.dxftype() == 'LWPOLYLINE':
                attrs['points'] = [list(p) for p in entity.get_points()]
            if entity.dxftype() == 'INSERT':
                attrs['attributes'] = [a.dxf.all_existing_dxf_attribs() for a in entity.attribs]
            rows.append(obj('elements', entity.dxf.handle, attrs.get('text') or attrs.get('name') or '', entity.dxftype(), json_value(attrs),
                            identifiers={'handle': entity.dxf.handle}, layer=attrs.get('layer', ''), parent=block.block_record_handle,
                            evidence={'handle': entity.dxf.handle, 'block': block.name, 'property_path': ['properties']}, value_semantics='saved_dxf; drawing units retained'))
    for layout in drawing.layouts:
        rows.append(obj('layouts', layout.layout_key, layout.name, 'LAYOUT', json_value(layout.dxf_layout.dxf.all_existing_dxf_attribs())))
    return rows, {'status': 'partial', 'units': {'INSUNITS': drawing.header.get('$INSUNITS', 0)}, 'limitations': ['No xref files are opened. Proxy/custom entities and evaluated CAD tables may be incomplete. Layout settings are not rendered sheets.']}


def dwg_data(source, folder):
    output = folder/'cad.json'
    proc = subprocess.run([node_path(), str(cad_path()), str(source), str(output)], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180)
    if proc.returncode or not output.is_file():
        raise ValueError('DWG reader failed: '+(proc.stderr or proc.stdout)[-1800:])
    if output.stat().st_size > 128*1024**2:
        raise ValueError('CAD metadata exceeds the bounded output budget')
    data = json.loads(output.read_text(encoding='utf-8'))
    rows = []
    for section, items in data['sections'].items():
        for index, item in enumerate(items):
            handle = str(item.get('handle', ''))
            rows.append(obj(section, handle or 'unidentified:'+str(index), item.get('name') or item.get('text') or '', item.get('type') or section, item,
                            identifiers={'handle': handle or None}, layer=item.get('layer', ''), parent=item.get('ownerBlockRecordSoftId', ''),
                            evidence={'handle': handle or None, 'section': section, 'index': index, 'property_path': ['properties']}, value_semantics='saved_dwg; drawing units retained'))
    return rows, {'status': 'partial', 'units': data.get('units'), 'diagnostics': data.get('diagnostics', []), 'limitations': ['Separate GPL reader, no AutoCAD. Only decoded classes; no xref opening or complete custom-object/table evaluation.']}


def nwd_data(workspace, source, folder):
    output = folder/'navis'
    proc = subprocess.run([str(nwd_path(workspace)), str(source), str(output), '--metadata-only'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180)
    if proc.returncode or not (output/'logical-models.json').is_file():
        raise ValueError('NWD/NWC reader failed: '+(proc.stderr or proc.stdout)[-1800:])
    if (output/'logical-models.json').stat().st_size > 128*1024**2:
        raise ValueError('Navis metadata exceeds output budget')
    from .model_navis import project_navis
    return project_navis(json.loads((output/'logical-models.json').read_text(encoding='utf-8')))


def rvt_data(workspace, project, doc_id, request_id):
    from .construction.rvt_data import RvtData, selected_classes
    from .core import connection
    native = RvtData(workspace)
    rows, reports = [], []
    for profile in ('objects', 'views'):
        result = native.extract(project, doc_id, request_id+':'+profile, profile)
        eid = result['extraction_id']
        inventory = json.loads(Path(result['classes_file']).read_text(encoding='utf-8'))
        type_classes = set(selected_classes('types', {c['name']: c for c in inventory['classes']}))
        reports.append({k: v for k, v in result.items() if k not in {'classes_file', 'summary_file'}})
        with connection(workspace.db_path(project), readonly=True) as db:
            for entry in db.execute('select record_id,element_id,kind,class_name,name,status,payload from rvt_native_records where extraction_id=? order by record_id', (eid,)):
                record = json.loads(entry['payload'])
                section = {'schedule': 'schedules', 'view': 'views', 'placement': 'views'}.get(entry['kind'], 'elements')
                cls = entry['class_name']
                if cls in ('RbsHvacSystem', 'RbsPipingSystem', 'RbsElectricalSystem'):
                    section = 'systems'
                elif cls == 'Level':
                    section = 'levels'
                elif cls in type_classes:
                    section = 'types'
                metadata = record.get('saved_metadata') or {}
                properties = {'saved_metadata': metadata, 'mep_system': record.get('mep_system'), 'root_fields': record.get('root_fields') or ((record.get('graph') or {}).get('objects') or [{}])[0].get('fields', {})}
                rows.append(obj(section, entry['element_id']+':'+profile, entry['name'], cls, properties,
                                identifiers={'element_id': entry['element_id'], 'unique_id': record.get('identity', {}).get('unique_id'), 'native_record_id': entry['record_id']},
                                evidence={'extraction_id': eid, 'record_id': entry['record_id'], 'source': record.get('source'), 'detail_tool': 'get_rvt_record'},
                                native_status=entry['status'], value_semantics='serialized_not_evaluated; use native record for schedule/view graph',
                                diagnostics=[s for s in [record.get('diagnostic'), record.get('metadata_diagnostic')] if s]))
    return rows, {'status': 'partial', 'native_extractions': reports, 'limitations': ['No Revit/IFC required. Selected current records only; extraction budgets and native coverage apply.', 'Saved views are settings, schedules are definitions/cells, not application-evaluated drawings or body totals.']}
