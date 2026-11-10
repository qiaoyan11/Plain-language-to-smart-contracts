"""Offline tests for Agent 3. They never call the network."""
import copy
import json
import unittest
from shared.handoff import ROOT, validate
from agent3 import rules

PAYLOAD = json.loads((ROOT / 'shared/examples/planAction.request.json').read_text())['payload']


def state(funded=False, paid=()):
    p = copy.deepcopy(PAYLOAD)
    snap = p['snapshot']
    snap['funded'] = funded
    total = 0
    for m in snap['milestones']:
        m['paid'] = m['id'] in paid
        if not m['paid']:
            total += int(m['amountWei'])
    snap['escrowBalanceWei'] = str(total) if funded else '0'
    return p


def parsed(kind, mid=None, lang='en'):
    return {'kind': kind, 'milestoneId': mid, 'language': lang}


class RulesTest(unittest.TestCase):
    def run_rules(self, kind, payload=None, mid=None, lang='en'):
        result = rules.decide(parsed(kind, mid, lang), payload or state())
        validate('PlanResult', result)
        return result

    def assert_blocked(self, result):
        self.assertEqual(result['status'], 'blocked')
        self.assertIsNone(result['intent'])
        self.assertIsNone(result['question'])

    def test_address_mismatch_blocked(self):
        p = state()
        p['snapshot']['contractAddress'] = '0x' + '22' * 20
        self.assert_blocked(self.run_rules('query', p))

    def test_unsupported_blocked(self):
        self.assert_blocked(self.run_rules('unsupported'))

    def test_unclear_asks(self):
        r = self.run_rules('unclear')
        self.assertEqual(r['status'], 'needsClarification')
        self.assertIsNotNone(r['question'])

    def test_query_ready(self):
        r = self.run_rules('query')
        self.assertEqual(r['status'], 'readyForConfirmation')
        self.assertEqual(r['intent']['action'], 'query')
        self.assertIsNone(r['intent']['milestoneId'])
        self.assertIn('0.003', r['summary'])
        self.assertIn('0.007', r['summary'])

    def test_query_ignores_milestone_id(self):
        self.assertIsNone(self.run_rules('query', mid=2)['intent']['milestoneId'])

    def test_deposit_ready(self):
        r = self.run_rules('deposit')
        self.assertEqual(r['status'], 'readyForConfirmation')
        self.assertEqual(r['intent']['action'], 'deposit')
        self.assertIn('0.01', r['summary'])

    def test_deposit_twice_blocked(self):
        self.assert_blocked(self.run_rules('deposit', state(funded=True)))

    def test_accept_all_paid_blocked(self):
        self.assert_blocked(self.run_rules('acceptMilestone', state(True, (1, 2))))

    def test_accept_without_id_asks(self):
        r = self.run_rules('acceptMilestone', state(True))
        self.assertEqual(r['status'], 'needsClarification')
        self.assertIsNone(r['intent'])
        self.assertIn('1', r['question'])
        self.assertIn('Homepage accepted', r['question'])
        self.assertTrue(r['summary'])

    def test_accept_unknown_id_blocked(self):
        self.assert_blocked(self.run_rules('acceptMilestone', state(True), mid=5))

    def test_accept_unfunded_blocked(self):
        self.assert_blocked(self.run_rules('acceptMilestone', state(False), mid=1))

    def test_accept_paid_blocked(self):
        self.assert_blocked(self.run_rules('acceptMilestone', state(True, (1,)), mid=1))

    def test_accept_out_of_order_blocked(self):
        r = self.run_rules('acceptMilestone', state(True), mid=2)
        self.assert_blocked(r)
        self.assertIn('1', r['summary'])

    def test_accept_ready(self):
        r = self.run_rules('acceptMilestone', state(True), mid=1)
        self.assertEqual(r['status'], 'readyForConfirmation')
        self.assertIsNone(r['question'])
        self.assertEqual(r['intent'], {
            'projectId': 'demo-001', 'chainId': 31337,
            'contractAddress': '0x1111111111111111111111111111111111111111',
            'action': 'acceptMilestone', 'milestoneId': 1})
        self.assertIn('0.003', r['summary'])
        self.assertIn('0x7099…79C8', r['summary'])

    def test_accept_second_ready(self):
        r = self.run_rules('acceptMilestone', state(True, (1,)), mid=2)
        self.assertEqual(r['status'], 'readyForConfirmation')
        self.assertEqual(r['intent']['milestoneId'], 2)

    def test_chinese_template(self):
        r = self.run_rules('acceptMilestone', state(True), mid=1, lang='zh')
        self.assertIn('尚未发送任何交易', r['summary'])

    def test_unknown_language_uses_english(self):
        r = self.run_rules('acceptMilestone', state(True), mid=1, lang='fr')
        self.assertIn('No transaction has been sent', r['summary'])

    def test_refusal_and_clarify_validate(self):
        for key in ('model_error', 'too_long'):
            for lang in ('en', 'zh'):
                self.assert_blocked(rules.refusal(key, lang))
                validate('PlanResult', rules.refusal(key, lang))
        validate('PlanResult', rules.clarify('en'))
        self.assertEqual(rules.clarify('zh')['status'], 'needsClarification')

    def test_format_eth(self):
        self.assertEqual(rules.format_eth('3000000000000000'), '0.003')
        self.assertEqual(rules.format_eth('1000000000000000000'), '1')

    def test_guess_language(self):
        self.assertEqual(rules.guess_language('付一下'), 'zh')
        self.assertEqual(rules.guess_language('pay'), 'en')


if __name__ == '__main__':
    unittest.main()
