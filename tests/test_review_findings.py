import unittest
from uvyazka.core import compare_quantity
from uvyazka.coordination import inspect_graph
from uvyazka.findings import classify_report


def claim(value, unit):
    return {'entity': 'battery', 'property': 'capacity', 'basis': 'nominal', 'revision_set': 'issued', 'value': value, 'unit': unit}


class ReviewFindingTests(unittest.TestCase):
    def test_time_charge_aliases_and_dimensional_boundaries(self):
        for a, b in [(claim('24', 'ч'), claim('1440', 'min')), (claim('12', 'А·ч'), claim('12000', 'mAh')),
                     (claim('12', 'А⋅ч'), claim('12', 'Ah')), (claim('2', 'часы'), claim('7200', 's'))]:
            self.assertEqual(compare_quantity(a, b)['status'], 'matches')
        self.assertEqual(compare_quantity(claim('12', 'Ah'), claim('12', 'A'))['status'], 'not_comparable')
        self.assertEqual(compare_quantity(claim('12', 'Ah'), claim('12', 'Wh'))['status'], 'not_comparable')
        self.assertEqual(compare_quantity(claim('12', 'AH'), claim('12', 'Ah'))['status'], 'not_comparable')
        self.assertEqual(compare_quantity(claim('12', 'Ah'), claim('7', 'Ач'))['difference'], '-5')
        self.assertEqual(compare_quantity(claim('1', 'h'), claim('60.01', 'min'), '0.6')['status'], 'matches')

    def test_unsupported_units_are_a_question_not_a_cross_discipline_conflict(self):
        a={**claim('12', 'unsupported-unit'), 'discipline': 'APS'}
        b={**claim('12', 'Ah'), 'discipline': 'EOM'}
        graph={'entities': [{'id': 'battery', 'kind': 'building', 'claims': [a,b]}]}
        result=inspect_graph(graph)
        self.assertNotIn('cross_discipline_difference', {i['code'] for i in result['issues']})
        issue=next(i for i in result['issues'] if i['code']=='claim_comparison_unconfirmed')
        self.assertEqual(issue['category'], 'question')
        b['value']='7';a['unit']='А·ч'
        issue=next(i for i in inspect_graph(graph)['issues'] if i['code']=='cross_discipline_difference')
        self.assertEqual(issue['category'], 'discrepancy')
        self.assertFalse(issue['project_error_confirmed'])

    def test_connection_gap_is_unchecked_until_declared_scope_has_been_reviewed(self):
        graph={'entities': [{'id':'pump', 'ports':[{'id':'power','kind':'electrical','required':True}]}],
               'scope': {'expected_documents':['mechanical','electrical'], 'reviewed_documents':['mechanical'],
                         'expected_disciplines':['OV','EOM'], 'reviewed_disciplines':['OV']}}
        result=inspect_graph(graph)
        self.assertEqual(result['finding_counts']['discrepancy'],0)
        gap=next(i for i in result['issues'] if i['code']=='required_connection_missing')
        self.assertEqual(gap['category'],'unchecked')
        graph['scope']['reviewed_documents'].append('electrical');graph['scope']['reviewed_disciplines'].append('EOM')
        result=inspect_graph(graph)
        self.assertEqual(result['finding_counts'],{'discrepancy':1,'question':0,'unchecked':0})
        self.assertEqual(sum(result['finding_counts'].values()), result['issue_count'])

    def test_old_untyped_comparisons_need_reaudit_and_missing_values_are_unchecked(self):
        report=classify_report({'issues':[{'code':'cross_discipline_difference'}], 'coverage':{}})
        self.assertTrue(report['reaudit_recommended'])
        self.assertEqual(report['finding_counts']['question'],1)
        graph={'entities':[{'id':'b','kind':'building','claims':[dict(claim(None,'Ah'),discipline='APS'),dict(claim('12','Ah'),discipline='EOM')]}]}
        report=inspect_graph(graph)
        missing=next(i for i in report['issues'] if i['code']=='claim_value_missing')
        self.assertEqual(missing['category'],'unchecked')
        self.assertNotIn('cross_discipline_difference',{i['code'] for i in report['issues']})
