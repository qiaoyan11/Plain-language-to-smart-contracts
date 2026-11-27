import json
import os
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

from agent1.service import clarify, value_of
from flows.worker import dispatch


def example(name):
    return json.loads((Path(__file__).parent / 'examples' / (name + '.json')).read_text())


class AgentTests(unittest.TestCase):
    @patch('agent1.service.uuid4', return_value='example-project')
    def test_examples(self, _):
        for name in ('complete', 'missing-amount', 'refund', 'revisions'):
            with self.subTest(case=name):
                case = example(name)
                self.assertEqual(clarify(case['request']['payload'], lambda *_: case['exampleExtraction']),
                                 dict(case['expectedResult'], separateTerms=[]))

    def test_implicit_revision_wording_in_chinese(self):
        case = example('complete')
        payload = case['request']['payload']
        payload['message'] += '乙方持续修改至甲方满意。'
        result = clarify(payload, lambda *_: case['exampleExtraction'])
        self.assertEqual(result['status'], 'needsClarification')
        self.assertIn('验收', result['questions'][0]['question'])

    def test_revision_question_persists_until_replaced(self):
        case = example('revisions')
        first = case['request']['payload']['message']
        payload = dict(draftSpec=case['expectedResult']['draftSpec'],
                       history=[dict(role='user', content=first),
                                dict(role='assistant', content=json.dumps(case['expectedResult']))],
                       message='Keep the same wallet.')
        terms = case['exampleExtraction']
        terms['revisionResolutionQuote'] = 'Fabricated consent'
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['questions'][0]['field'], 'acceptance.openEndedRevisions')
        payload['message'] = 'We replace satisfaction with acceptance against mockup v2 and the checkout tests.'
        terms['revisionResolutionQuote'] = payload['message']
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'readyForConfirmation')

    def test_money(self):
        for quote in ('0.0000000000000000001 ETH', '99 ETH', '0 wei', '3%'):
            self.assertIsNone(value_of(quote, ['0.0000000000000000001 ETH, 199 ETH, 0 wei, 3%'], set(), '1'))
        self.assertEqual(value_of('0.010 test ETH', ['Escrow 0.010 test ETH'], set()), '10000000000000000')
        self.assertEqual(value_of('30%', ['首页30%'], set(), '100'), '30')
        self.assertEqual(value_of('0.012 ETH', ['0.012 ETH'], set()), '12000000000000000')

    def test_inconsistent_total(self):
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        payload['message'] += '\nActually make each amount 4 wei.'
        for row in terms['milestones']:
            row['amount'] = '4 wei'
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'needsClarification')
        self.assertIsNone(result['draftSpec']['totalAmountWei'])

    def test_follow_up(self):
        case = example('missing-amount')
        prior = case['expectedResult']['draftSpec']
        payload = dict(draftSpec=prior, history=[dict(role='user', content=case['request']['payload']['message'])],
                       message='Use 1 ETH split 30% then 70%.')
        result = clarify(payload, lambda *_: example('complete')['exampleExtraction'])
        self.assertEqual(result['status'], 'readyForConfirmation')
        self.assertEqual(result['draftSpec']['specVersion'], prior['specVersion'] + 1)
        self.assertEqual(result['draftSpec']['projectId'], prior['projectId'])

    def test_unverified_wallet(self):
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        payload['message'] = payload['message'].splitlines()[0]
        terms['clientWallet'] = '0x' + '3'*40
        result = clarify(payload, lambda *_: terms)
        self.assertIsNone(result['draftSpec']['clientWallet'])
        self.assertEqual(result['status'], 'needsClarification')

    def test_total_conflict_persists_until_current_answer(self):
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        payload['message'] = payload['message'].replace('(30%)', '(40%)')
        terms['milestones'][0]['amount'] = '40%'
        prior = clarify(payload, lambda *_: terms)
        self.assertIsNone(prior['draftSpec']['totalAmountWei'])
        followup = dict(message='Keep the same provider wallet.', draftSpec=prior['draftSpec'],
                        history=[dict(role='user', content=payload['message']),
                                 dict(role='assistant', content=json.dumps(prior))])
        terms = example('complete')['exampleExtraction']
        terms['total'] = None
        for row, old in zip(terms['milestones'], prior['draftSpec']['milestones']):
            row['amount'] = old['amountWei'] + ' wei'
        for resolutions in ([], [dict(field='totalAmountWei', userQuote='Escrow 1 ETH.')]):
            with self.subTest(resolutions=resolutions):
                terms['resolvedQuestions'] = resolutions
                result = clarify(followup, lambda *_: terms)
                self.assertEqual(result['status'], 'needsClarification')
                self.assertIsNone(result['draftSpec']['totalAmountWei'])
                self.assertIn(prior['questions'][0], result['questions'])
        followup['message'] = 'We change the total to 1.1 ETH and keep both installment amounts.'
        terms['total'] = '1.1 ETH'
        terms['resolvedQuestions'] = [dict(field='totalAmountWei', userQuote=followup['message'])]
        result = clarify(followup, lambda *_: terms)
        self.assertEqual(result['status'], 'readyForConfirmation')
        self.assertEqual(result['draftSpec']['totalAmountWei'], '1100000000000000000')

    def test_general_question_persists_until_current_answer(self):
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        payload['message'] += ' The parties have not agreed who approves payment.'
        terms['questions'] = [dict(field='approvalRole', question='Who approves each payment?')]
        prior = clarify(payload, lambda *_: terms)
        followup = dict(message='Keep the same wallet.', draftSpec=prior['draftSpec'],
                        history=[dict(role='user', content=payload['message']),
                                 dict(role='assistant', content=json.dumps(prior))])
        terms = example('complete')['exampleExtraction']
        result = clarify(followup, lambda *_: terms)
        self.assertEqual(result['status'], 'needsClarification')
        self.assertEqual(result['questions'], prior['questions'])
        followup['message'] = 'Both parties agree the client approves each payment.'
        terms['resolvedQuestions'] = [dict(field='approvalRole', userQuote=followup['message'])]
        result = clarify(followup, lambda *_: terms)
        self.assertEqual(result['status'], 'readyForConfirmation')

    def test_amount_quotes_must_match_complete_number(self):
        for source in ('1,500 ETH', '1, 500 ETH', "1'500 ETH", '1\u202f500 ETH', '1500 ETH'):
            with self.subTest(source=source):
                self.assertIsNone(value_of('500 ETH', [source], set()))
        self.assertEqual(value_of('500 ETH', ['Budget,500 ETH.'], set()), '500000000000000000000')
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        payload['message'] = payload['message'].replace('Escrow 1 ETH.', 'Escrow 1,500 ETH.')
        terms['total'] = '500 ETH'
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'needsClarification')
        self.assertIsNone(result['draftSpec']['totalAmountWei'])

    def test_wallet_quotes_must_match_complete_address(self):
        for prefix, suffix in (('', '22'), ('abc', ''), ('', '_suffix')):
            with self.subTest(prefix=prefix, suffix=suffix):
                case = example('complete')
                payload, terms = case['request']['payload'], case['exampleExtraction']
                wallet = terms['developerWallet']
                payload['message'] = payload['message'].replace(wallet, prefix + wallet + suffix)
                result = clarify(payload, lambda *_: terms)
                self.assertEqual(result['status'], 'needsClarification')
                self.assertIsNone(result['draftSpec']['developerWallet'])
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        wallet = terms['developerWallet']
        payload['message'] = payload['message'].replace(wallet, '(' + wallet + ')')
        self.assertEqual(clarify(payload, lambda *_: terms)['status'], 'readyForConfirmation')

    def test_refund_persists_across_unrelated_followup(self):
        case = example('refund')
        terms = example('complete')['exampleExtraction']
        payload = case['request']['payload']
        payload.update(history=[dict(role='user', content=payload['message']),
                                dict(role='assistant', content=json.dumps(case['expectedResult']))],
                       message="Here is the same provider wallet.", draftSpec=case['expectedResult']['draftSpec'])
        self.assertEqual(clarify(payload, lambda *_: terms)['status'], 'unsupported')
        condition = case['expectedResult']['unsupportedTerms'][0]
        payload['message'] = "Both parties agree to remove the late-delivery refund."
        terms.update(unsupportedTerms=[], withdrawals=[dict(condition=condition, userQuote=payload['message'])])
        self.assertEqual(clarify(payload, lambda *_: terms)['status'], 'readyForConfirmation')

    def test_separate_terms_reach_handoff_without_entering_spec(self):
        from agent1.service import draft_agreement
        from agent1.template import render
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        note = "Both parties will document two revision rounds in a separate agreement."
        payload['message'] += '\n' + note
        terms['separateTerms'] = [note]
        result, notes = draft_agreement(payload, lambda *_: terms)
        self.assertIn(note, render(result, notes))
        self.assertNotIn(note, json.dumps(result))
        handoff = clarify(payload, lambda *_: terms)
        self.assertEqual(handoff['separateTerms'], [note])
        self.assertNotIn(note, json.dumps(handoff['draftSpec']))
        terms['separateTerms'] = ['Invented term']
        with self.assertRaises(ValueError):
            draft_agreement(payload, lambda *_: terms)

    def test_transport_and_worker(self):
        case = example('complete')
        note = 'Both parties keep attribution obligations in a separate agreement.'
        case['request']['payload']['message'] += '\n' + note
        case['exampleExtraction']['separateTerms'] = [note]
        bodies = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                bodies.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.end_headers()
                data = dict(choices=[dict(finish_reason='stop', message=dict(content=json.dumps(case['exampleExtraction'])))])
                self.wfile.write(json.dumps(data).encode())
            def log_message(self, *args):
                pass
        with HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = Thread(target=server.handle_request, daemon=True)
            thread.start()
            with patch.dict(os.environ, AGENT1_MODE='live', AGENT1_MODEL='local-test',
                            AGENT1_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1'):
                response = dispatch(case['request'])
            thread.join(3)
        self.assertEqual(response['result']['status'], 'readyForConfirmation')
        self.assertEqual(response['result']['separateTerms'], [note])
        self.assertEqual(bodies[0]['model'], 'local-test')
