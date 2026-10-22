import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from uvyazka.core import Workspace, connection, encode
from uvyazka.construction.rvt_data import RvtData
from uvyazka.construction.rvt_data_tools import register_tools


class ParameterSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        source = root / 'source'
        source.mkdir()
        self.ws = Workspace(root / 'state')
        self.ws.create_project('one', 'One', source)
        other = root / 'other'
        other.mkdir()
        self.ws.create_project('two', 'Two', other)
        self.data = RvtData(self.ws)
        self.key = 'a' * 64
        self.path = self.data.db('one')
        self.snapshot = {'source': {'doc_id': 'synthetic', 'sha256': 'b' * 64},
                         'status': 'partial', 'profile': 'all', 'record_count': 3}
        self.put(0, '10', 'Room', None)
        self.put(1, '20', 'FamilyInstance', [
            {'name': 'Мощность', 'raw_value': 0},
            {'name': 'Мощность неизвестна', 'raw_value': None},
            {'name': 'Пустая строка', 'raw_value': ''},
            {'name': 'Флаг', 'raw_value': False}])
        self.put(2, '30', 'FamilySymbol', [{'name': 'Мощность типа', 'raw_value': 5}])
        with connection(self.path) as db:
            db.execute('insert into rvt_extractions values (?,?)', (self.key, encode(self.snapshot)))

    def put(self, rid, eid, cls, parameters):
        record = {'identity': {'element_id': int(eid)}, 'class_name': cls,
                  'status': 'complete_bounded_graph',
                  'source': {'stream': 'Partitions/1', 'group_record_offset': rid * 100},
                  'graph': {'objects': [], 'edges': []},
                  'saved_metadata': None if parameters is None else {
                      'parameter_sets': [{'source_object': 0, 'parameters': parameters}]}}
        with connection(self.path) as db:
            db.execute('insert or replace into rvt_native_records values (?,?,?,?,?,?,?,?)',
                       (self.key, rid, eid, cls, 'element', '', record['status'], encode(record)))

    def test_empty_batch_continues_and_returns_each_match_once_without_rereading_rvt(self):
        with patch.object(RvtData, 'invoke', side_effect=AssertionError('Must use cached records')):
            first = self.data.search_parameters('one', self.key, 'МОЩНОСТЬ', limit=1, max_scan_records=1)
            self.assertEqual(first['items'], [])
            self.assertEqual(first['scanned_records_without_metadata'], 1)
            self.assertIsNotNone(first['next_cursor'])
            found = []
            page = first
            for _ in range(10):
                found.extend(page['items'])
                if page['next_cursor'] is None:
                    break
                page = self.data.search_parameters('one', self.key, 'МОЩНОСТЬ',
                                                  cursor=page['next_cursor'], limit=1, max_scan_records=1)
            self.assertTrue(page['search_exhausted'])
            self.assertFalse(page['absence_verified'])
            self.assertEqual(page['snapshot_status'], 'partial')
            self.assertEqual([(r['element_id'], r['parameter']['raw_value']) for r in found],
                             [('20', 0), ('20', None), ('30', 5)])
            for row in found:
                actual = self.data.record('one', self.key, row['record_id'], 'value', json_path=row['json_path'])
                self.assertEqual(json.loads(actual['json_text'])['raw_value'], row['parameter']['raw_value'])
                self.assertIn('stream', row['native_source'])

    def test_exact_filters_preserve_empty_null_zero_false_and_do_not_inherit_type_values(self):
        page = self.data.search_parameters('one', self.key, element_id='20', class_name='FamilyInstance')
        values = [r['parameter']['raw_value'] for r in page['items']]
        self.assertEqual(values[:3], [0, None, ''])
        self.assertIs(values[3], False)
        self.assertEqual(page['scanned_records'], 1)
        self.assertTrue(page['search_exhausted'])
        self.assertEqual(self.data.search_parameters('one', self.key, element_id='2')['items'], [])

    def test_output_budget_and_truncation_keep_record_and_field_locators(self):
        self.put(1, '20', 'FamilyInstance', [{'name': str(i), 'raw_value': 'я' * 5000} for i in range(30)])
        page = self.data.search_parameters('one', self.key, element_id='20', limit=100)
        self.assertLess(page['returned_count'], 30)
        self.assertLess(len(encode(page)), 23000)
        found = []
        for _ in range(10):
            for row in page['items']:
                self.assertTrue(row['truncated'])
                self.assertEqual(row['record_id'], 1)
                found.append(row['json_path'][-1])
            if page['next_cursor'] is None:
                break
            page = self.data.search_parameters('one', self.key, element_id='20', limit=100, cursor=page['next_cursor'])
        self.assertEqual(found, list(range(30)))
        value = self.data.record('one', self.key, 1, 'value', json_path=page['items'][-1]['json_path'], max_chars=10000)
        self.assertEqual(json.loads(value['json_text'])['raw_value'], 'я' * 5000)

    def test_cursor_is_bound_to_query_snapshot_and_project_and_budgets_are_validated(self):
        cursor = self.data.search_parameters('one', self.key, max_scan_records=1)['next_cursor']
        with self.assertRaisesRegex(ValueError, 'different RVT parameter search'):
            self.data.search_parameters('one', self.key, query='changed', cursor=cursor)
        with self.assertRaises(ValueError):
            self.data.search_parameters('two', self.key)
        for kwargs in [{'limit': 0}, {'max_scan_records': 101}, {'limit': True}, {'query': 123}]:
            with self.assertRaises(ValueError):
                self.data.search_parameters('one', self.key, **kwargs)
        with self.assertRaisesRegex(ValueError, 'Invalid RVT parameter cursor'):
            self.data.search_parameters('one', self.key, cursor={**cursor, 'parameter_offset': -1})

    def test_mcp_entrypoint_reads_same_snapshot(self):
        class Registry:
            def __init__(self):
                self.functions = {}
            def tool(self, **kwargs):
                def add(function):
                    self.functions[function.__name__] = function
                    return function
                return add
        registry = Registry()
        register_tools(registry, self.ws)
        result = registry.functions['find_rvt_parameters']('one', self.key, element_id='30')
        self.assertEqual(result['items'][0]['parameter']['raw_value'], 5)
        self.assertEqual(result['source'], self.snapshot['source'])
