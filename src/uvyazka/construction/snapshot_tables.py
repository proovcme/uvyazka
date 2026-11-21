"""Tabular projections of exact fields in saved metadata, with no scene dependency."""
import csv
import io

from ..core import connection, encode
from ..model_data import ModelData, decode_object, table_cells, table_columns


REVISION = 'uvyazka-snapshot-tables-v1'


def build(workspace, project, dataset_id, definition):
    if not isinstance(definition, dict) or set(definition) - {'section', 'query', 'native_id', 'filters', 'search_properties', 'columns'}:
        raise ValueError('Snapshot table needs columns and optional selection criteria')
    columns = table_columns(definition.get('columns'))
    section = definition.get('section', 'elements')
    query = definition.get('query', '')
    native_id = definition.get('native_id')
    search_properties = definition.get('search_properties', False)
    service = ModelData(workspace)
    filters = service.selection(section, query, native_id, definition.get('filters'), search_properties)
    dataset = service.dataset(project, dataset_id)
    term = query.casefold()
    rows, size = [], 0
    with connection(workspace.db_path(project), readonly=True) as db:
        records = db.execute('select payload from model_objects where dataset_id=? and section=? order by ordinal', (dataset_id, section))
        for record in records:
            row = decode_object(record['payload'])
            if not service.selected(row, term, native_id, filters, search_properties):
                continue
            result = {'object_id': row['object_id'], 'native_id': row['native_id'], 'cells': table_cells(row, columns)}
            size += len(encode(result).encode('utf-8'))
            if len(rows) >= 100_000 or size > 32 * 1024**2:
                raise ValueError('Table budget exceeded (100000 rows / 32 MiB); narrow the selection or choose fewer columns')
            rows.append(result)
    return {'dataset_id': dataset_id, 'source': dataset['source'], 'reader': dataset['reader'],
            'coverage': dataset['coverage'], 'definition': definition, 'rows': rows,
            'value_semantics': 'saved_metadata_in_source_units', 'release_ready': False}


def render(report, format):
    if format == 'json':
        return encode(report)
    if format != 'csv':
        raise ValueError('Snapshot table supports CSV or JSON')

    def safe_text(value):
        if value.lstrip().startswith(('=', '+', '-', '@')) or value.startswith(('\t', '\r', '\n')):
            return "'" + value
        return value

    def cell_text(cell):
        if cell['status'] == 'absent':
            return ''
        value = cell['value']
        if isinstance(value, str):
            return safe_text(value) if value else '""'
        return encode(value)

    output = io.StringIO(newline='')
    writer = csv.writer(output, delimiter=';')
    writer.writerow(['ID объекта', 'ID в исходнике', *[safe_text(column['title']) for column in report['definition']['columns']]])
    for row in report['rows']:
        writer.writerow([row['object_id'], safe_text(row['native_id']), *map(cell_text, row['cells'])])
    return '\ufeff' + output.getvalue()
