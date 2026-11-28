"""v2 review-period generation path with an injected model reply and the real v2 validator.

Run: .venv/bin/python -m unittest discover -s tests/v2 -p 'test_*.py'   (no paid model calls)
"""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from agent2.prompts import build_messages, prompt_versions  # noqa: E402
from flows.generation import run_generation, review_validator  # noqa: E402

REQUEST = json.loads((ROOT / 'agent2/examples/generate.request.json').read_text())
REFERENCE = (ROOT / 'contracts/MilestoneReviewEscrow.sol').read_text().replace(
    'contract MilestoneReviewEscrow ', 'contract GeneratedMilestoneEscrow ')


def review_request(period=864000, limit=0):
    request = copy.deepcopy(REQUEST)
    request['payload']['spec'].update(reviewPeriodSeconds=period, changeRequestLimit=limit)
    # Development validation, as the local backend runs it; the injected reply needs no repair.
    request['payload']['runConfig'].update(validationMode='development', maxRepairs=0, feedbackSetting='C')
    return request


def reply(source):
    return {'source': source, 'metadata': {'apiCalls': 1, 'usage': {'input_tokens': 10, 'output_tokens': 20}}, 'error': None}


class ReviewGenerationTests(unittest.TestCase):
    def test_prompt_states_the_review_rules_and_both_interfaces(self):
        spec = review_request()['payload']['spec']
        system, user = build_messages(spec)
        self.assertIn('implement IMilestoneReviewEscrow', system)
        self.assertNotIn('implement IMilestoneEscrow without altering it', system)
        self.assertIn('interface IMilestoneReviewEscrow is IMilestoneEscrow', user)
        self.assertIn('"reviewPeriodSeconds": 864000', user)
        self.assertEqual(prompt_versions(spec)[0], 'review-v2-single-generation-1')
        # A v1 specification is unchanged.
        v1_system, _ = build_messages(REQUEST['payload']['spec'])
        self.assertNotIn('review period', v1_system)

    def test_reference_contract_passes_generation_and_validation(self):
        request = review_request()
        run = run_generation(request, model_call=lambda *_: reply(REFERENCE))
        result = run['response']['result']
        self.assertEqual(result['status'], 'validated', json.dumps(result['validationReport'], indent=1)[:3000])
        self.assertIn('IMilestoneReviewEscrow.sol', result['sourceBundle']['sources'])
        self.assertTrue(result['validationReport']['suiteVersion'].endswith(';review-v1'))
        self.assertEqual(run['prompts']['version'], 'review-v2-single-generation-1')

    def test_a_contract_with_another_period_fails_the_confirmed_rules(self):
        request = review_request(period=7 * 86400)
        run = run_generation(request, model_call=lambda *_: reply(REFERENCE))
        report = run['response']['result']['validationReport']
        self.assertEqual(report['status'], 'failed')
        clauses = next(c for c in report['checks'] if c['name'] == 'clauseTests')
        self.assertIn('CLAUSE_REVIEW_CONSTANTS', [f['code'] for f in clauses['findings']])

    def test_a_v1_contract_fails_the_v2_interface(self):
        v1 = (ROOT / 'contracts/MilestoneEscrow.sol').read_text().replace('contract MilestoneEscrow ', 'contract GeneratedMilestoneEscrow ')
        request = review_request()
        spec = request['payload']['spec']
        bundle = run_generation(request, model_call=lambda *_: reply(v1))['response']['result']['sourceBundle']
        report = review_validator().validate_review(spec, bundle)
        compilation = next(c for c in report['checks'] if c['name'] == 'compilation')
        self.assertEqual(compilation['status'], 'failed')
        self.assertIn('INTERFACE_MISMATCH', [f['code'] for f in compilation['findings']])


if __name__ == '__main__':
    unittest.main()
