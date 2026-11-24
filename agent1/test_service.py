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
                                 case['expectedResult'])

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

    def test_separate_terms_only_in_worksheet(self):
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
        terms['separateTerms'] = ['Invented term']
        with self.assertRaises(ValueError):
            draft_agreement(payload, lambda *_: terms)

    def test_transport_and_worker(self):
        case = example('complete')
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
        self.assertEqual(bodies[0]['model'], 'local-test')
