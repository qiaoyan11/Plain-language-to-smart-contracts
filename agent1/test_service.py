import json
import os
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

from agent1.service import clarify, repeats_payment, value_of
from flows.worker import dispatch


def example(name):
    return json.loads((Path(__file__).parent / 'examples' / (name + '.json')).read_text())


FINANCE_MESSAGES = [
    'I want build a finance application',
    '0.08',
    'Part A need to check whether part B make a good application. the evaluation stage would be functions in application completed by part B. for example, if part B finished market display function, Part A need to pay 0.02, and if part B finished chat bot section, part A pay 0.02, and then is trade signal alert section (0.02), and user UI design 0.02',
    '0.08 ETH in total.',
    '25% of 0.08 ETH will be paid for milstone 1',
]
FINANCE_TITLES = ['market display function', 'chat bot section', 'trade signal alert section', 'user UI design']


class AgentTests(unittest.TestCase):
    @patch('agent1.service.uuid4', return_value='example-project')
    def test_examples(self, _):
        for name in ('complete', 'missing-amount', 'refund', 'revisions'):
            with self.subTest(case=name):
                case = example(name)
                self.assertEqual(clarify(case['request']['payload'], lambda *_: case['exampleExtraction']),
                                 dict(case['expectedResult'], separateTerms=[]))

    def test_unicode_revision_clause_keeps_source_quote_and_english_question(self):
        case = example('complete')
        payload = case['request']['payload']
        clause = '\u4e59\u65b9\u6301\u7eed\u4fee\u6539\u81f3\u7532\u65b9\u6ee1\u610f\u3002'
        payload['message'] += clause
        result = clarify(payload, lambda *_: case['exampleExtraction'])
        self.assertEqual(result['status'], 'needsClarification')
        self.assertIn('Which agreed mockup or test determines acceptance?', result['questions'][0]['question'])
        self.assertIn('\u4fee\u6539\u81f3\u7532\u65b9\u6ee1\u610f', result['questions'][0]['question'])

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
        self.assertEqual(value_of('30%', ['\u9996\u987530%'], set(), '100'), '30')
        self.assertEqual(value_of('0.012 ETH', ['0.012 ETH'], set()), '12000000000000000')

    def test_bare_quotes_keep_the_unit_or_multiplier_written_by_the_user(self):
        for phrase in ('usd 0.02', '0.02 USDC', '0.02 dollars', 'btc 0.02',
                       '0.02 gwei', '0.02 percent', '0.02 million', '$0.02',
                       '0.02 wei', '0.02%', '0.020', '10.02'):
            with self.subTest(phrase=phrase):
                self.assertIsNone(value_of('0.02', [phrase], set(), unit='eth'))
        self.assertEqual(value_of('0.02', ['Pay 0.02 after delivery.'], set(), unit='eth'),
                         '20000000000000000')
        self.assertIsNone(value_of('0.02', ['Pay 0.02 after delivery.'], set()))
        self.assertEqual(value_of('0.02 ETH', ['Pay 0.02 on delivery.'], set(), unit='eth'),
                         '20000000000000000')
        self.assertIsNone(value_of('0.02 ETH', ['Pay 0.02 dollars on delivery.'], set(), unit='eth'))

    def test_repeating_a_known_payment_preserves_the_schedule_and_separate_terms(self):
        prior = example('complete')['expectedResult']
        prior['status'] = 'needsClarification'
        spec = prior['draftSpec']
        spec['clientWallet'] = None
        prior['questions'] = [dict(field='clientWallet', question='What wallet will fund this agreement?')]
        notes = ['The developer will provide a PDF manual separately.']
        history = [dict(role='assistant', content=json.dumps(dict(result=prior, separateTerms=notes)))]
        for message in ('1 ETH in total.', '30% of 1 ETH will be paid for milstone 1',
                        '0.7 ETH for stage 2'):
            with self.subTest(message=message):
                result = clarify(dict(message=message, draftSpec=spec, history=history),
                                 lambda *_: self.fail('Restating a known amount does not need extraction'))
                self.assertEqual(result, dict(prior, separateTerms=notes))
        for message in ('40% of 1 ETH for stage 1', '30% of 2 ETH for stage 1',
                        '1 ETH in total if I keep both stages', 'Possibly 1 ETH in total',
                        '0.3 ETH for stage 1; put stage 2 on hold'):
            with self.subTest(message=message):
                self.assertFalse(repeats_payment(message, spec))

    def test_unicode_amount_units_preserve_evidence_and_english_fallback_questions(self):
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        payload['message'] = ('Website. Client ' + terms['clientWallet'] + ', provider ' + terms['developerWallet']
                              + '. Total 0.01 \u6d4b\u8bd5 ETH, homepage 30\uff05, complete site 70\uff05.'
                              + ' The client approves in order. No refund, automatic release or timeout is required.')
        terms['total'] = '0.01 \u6d4b\u8bd5 ETH'
        terms['milestones'][0]['amount'], terms['milestones'][1]['amount'] = '30\uff05', '70\uff05'
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'readyForConfirmation')
        self.assertEqual(result['draftSpec']['totalAmountWei'], '10000000000000000')
        self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']],
                         ['3000000000000000', '7000000000000000'])
        self.assertEqual(result['unsupportedTerms'], [])
        self.assertIsNone(value_of('0.01 test ETH', [payload['message']], set()))
        self.assertIsNone(value_of('30%', [payload['message']], set(), '100'))
        payload['message'] = payload['message'].replace(terms['developerWallet'], '[not supplied]')
        terms['developerWallet'] = None
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['questions'], [dict(field='developerWallet', question='What is the provider wallet address?')])

    def test_current_wallet_answers_clear_missing_fields_without_resolution_metadata(self):
        case = example('complete')
        prior = case['expectedResult']
        prior['status'] = 'needsClarification'
        prior['draftSpec']['clientWallet'] = prior['draftSpec']['developerWallet'] = None
        prior['questions'] = [dict(field='clientWallet', question='What is the client wallet?'),
                              dict(field='developerWallet', question='What is the provider wallet?')]
        terms = case['exampleExtraction']
        client, provider = terms['clientWallet'], terms['developerWallet']
        terms['developerWallet'] = None
        terms['questions'] = list(prior['questions'])
        payload = dict(message=client, draftSpec=prior['draftSpec'], history=[
            dict(role='user', content='Website total 1 ETH, homepage 30%, complete site 70%. Wallets are not supplied.'),
            dict(role='assistant', content=json.dumps(prior))])
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'needsClarification')
        self.assertEqual([q['field'] for q in result['questions']], ['developerWallet'])
        self.assertIn('provider', result['questions'][0]['question'])
        payload['history'].extend([dict(role='user', content=client),
                                   dict(role='assistant', content=json.dumps(result))])
        payload.update(message=provider, draftSpec=result['draftSpec'])
        terms['developerWallet'] = provider
        terms['questions'] = list(result['questions'])
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'readyForConfirmation')

    def test_current_percentages_fill_missing_amounts_using_retained_total(self):
        case = example('complete')
        prior, terms = case['expectedResult'], case['exampleExtraction']
        prior['status'] = 'needsClarification'
        for milestone in prior['draftSpec']['milestones']:
            milestone['amountWei'] = None
        prior['questions'] = [dict(field=f'milestones.{n}.amountWei', question='What is the amount?') for n in (1, 2)]
        payload = dict(message='30\uff05', draftSpec=prior['draftSpec'], history=[
            dict(role='user', content='Website total 1 ETH, with homepage and complete-site milestones. Allocation is unresolved.'),
            dict(role='assistant', content=json.dumps(prior))])
        terms['total'] = None
        terms['milestones'][0]['amount'], terms['milestones'][1]['amount'] = '30\uff05', None
        terms['questions'] = list(prior['questions'])
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'needsClarification')
        self.assertEqual([q['field'] for q in result['questions']], ['milestones.2.amountWei'])
        payload['history'].extend([dict(role='user', content=payload['message']),
                                   dict(role='assistant', content=json.dumps(result))])
        payload.update(message='70\uff05', draftSpec=result['draftSpec'])
        terms['milestones'][0]['amount'] = result['draftSpec']['milestones'][0]['amountWei'] + ' wei'
        terms['milestones'][1]['amount'] = '70\uff05'
        terms['questions'] = list(result['questions'])
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'readyForConfirmation')
        self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']],
                         ['300000000000000000', '700000000000000000'])

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

    def test_mentioned_candidates_do_not_clear_ambiguity_questions(self):
        for field in ('totalAmountWei', 'milestones.1.amountWei', 'developerWallet'):
            for followup in (False, True):
                with self.subTest(field=field, followup=followup):
                    case = example('complete')
                    payload, terms = case['request']['payload'], case['exampleExtraction']
                    question = dict(field=field, question='There are two candidate values. Which one have both parties agreed?')
                    candidates = {'totalAmountWei': 'Total 1 ETH or 2 ETH, still undecided.',
                                  'milestones.1.amountWei': 'Homepage allocation 30% or 40%, still undecided.',
                                  'developerWallet': terms['developerWallet'] + ' or 0x' + '3'*40 + ', still undecided.'}
                    terms['questions'] = [question]
                    if followup:
                        prior = case['expectedResult']
                        prior.update(status='needsClarification', questions=[question])
                        if field == 'milestones.1.amountWei':
                            prior['draftSpec']['milestones'][0]['amountWei'] = None
                        else:
                            prior['draftSpec'][field] = None
                        payload['history'] = [dict(role='user', content=payload['message']),
                                              dict(role='assistant', content=json.dumps(prior))]
                        payload['draftSpec'] = prior['draftSpec']
                        payload['message'] = candidates[field]
                    else:
                        payload['message'] += candidates[field]
                    result = clarify(payload, lambda *_: terms)
                    self.assertEqual(result['status'], 'needsClarification')
                    self.assertIn(question, result['questions'])
                    if field == 'totalAmountWei':
                        self.assertIsNone(result['draftSpec']['totalAmountWei'])

    def test_direct_value_answers_the_displayed_question_only(self):
        case = example('complete')
        prior, terms = case['expectedResult'], case['exampleExtraction']
        prior['status'] = 'needsClarification'
        prior['draftSpec']['clientWallet'] = prior['draftSpec']['developerWallet'] = None
        prior['questions'] = [dict(field='developerWallet', question='What is the provider wallet?'),
                              dict(field='clientWallet', question='What is the client wallet?')]
        payload = dict(message=terms['clientWallet'], draftSpec=prior['draftSpec'], history=[
            dict(role='user', content='Total 1 ETH, homepage 30%, complete site 70%.'),
            dict(role='assistant', content=json.dumps(dict(result=prior, question=prior['questions'][1])))])
        terms['developerWallet'] = None
        terms['questions'] = list(prior['questions'])
        result = clarify(payload, lambda *_: terms)
        self.assertEqual(result['status'], 'needsClarification')
        self.assertEqual([q['field'] for q in result['questions']], ['developerWallet'])

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
        # An invented term is not evidence: it is dropped, and the turn still succeeds.
        terms['separateTerms'] = ['Invented term', note]
        self.assertEqual(draft_agreement(payload, lambda *_: terms)[1], [note])

    def test_transport_and_worker(self):
        case = example('complete')
        focus = {'field': 'totalAmountWei', 'question': 'What total amount in ETH have both parties agreed?'}
        history = [
            {'role': 'user', 'content': 'I want to set up a payment agreement.'},
            {'role': 'assistant', 'content': json.dumps({'question': focus})},
        ]
        case['request']['payload']['history'] = history
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
        messages = bodies[0]['messages']
        self.assertEqual(messages[1:-1], history)
        self.assertEqual(messages[-1]['role'], 'user')
        self.assertEqual(json.loads(messages[-1]['content']), {
            'message': case['request']['payload']['message'], 'draftSpec': case['request']['payload']['draftSpec']})


class FinanceAmountTests(unittest.TestCase):
    """Scripted extraction regressions for the user's exact wording, not model accuracy scores."""

    def terms(self, total=None, amounts=()):
        terms = example('complete')['exampleExtraction']
        terms.update(name='Finance application', clientWallet=None, developerWallet=None,
                     total=total, changedFields=[], milestones=[dict(title=title, amount=amount)
                     for title, amount in zip(FINANCE_TITLES, amounts)])
        return terms

    def record(self, history, message, result, field='clientWallet'):
        question = dict(field=field, question='What total amount in ETH have both parties agreed?'
                        if field == 'totalAmountWei' else 'What value have both parties agreed?')
        history.extend([dict(role='user', content=message),
                        dict(role='assistant', content=json.dumps(dict(result=result, question=question)))])

    def legacy(self, complete=False):
        history, prior = [], None
        for index, message in enumerate(FINANCE_MESSAGES[:4]):
            spec = example('complete')['expectedResult']['draftSpec']
            spec.update(name='Finance application', clientWallet=None, developerWallet=None, specVersion=index + 1,
                        totalAmountWei='80000000000000000' if index == 3 else None,
                        milestones=[] if index < 2 else [dict(id=n, title=title,
                            amountWei='20000000000000000' if complete and index == 3 else None)
                            for n, title in enumerate(FINANCE_TITLES, 1)])
            questions = [dict(field='clientWallet', question='What is the client wallet address?'),
                         dict(field='developerWallet', question='What is the provider wallet address?')]
            if not complete or index < 3:
                questions.append(dict(field='milestones', question='What deliverables should the client accept, in payment order?'))
                if index < 3:
                    questions.append(dict(field='totalAmountWei', question='Please state the exact total in ETH or wei.'))
                if index >= 2:
                    questions.extend(dict(field=f'milestones.{n}.amountWei',
                        question=f'What exact amount is payable for milestone {n}?') for n in range(1, 5))
            prior = dict(status='needsClarification', draftSpec=spec, questions=questions,
                         unsupportedTerms=[], separateTerms=[])
            self.record(history, message, prior, 'totalAmountWei' if index < 3 else 'milestones.1.amountWei')
        return history, prior

    def test_exact_five_turn_finance_dialogue_keeps_verified_amounts(self):
        history, prior = [], None
        for index, message in enumerate(FINANCE_MESSAGES):
            terms = self.terms(None if index == 0 else '0.08 ETH', () if index < 2 else ['0.02'] * 4)
            if index == 4:
                terms['milestones'][0]['amount'] = '25% of 0.08 ETH'
            result = clarify(dict(message=message, history=history, draftSpec=prior), lambda *_: terms)
            if index >= 1:
                self.assertEqual(result['draftSpec']['totalAmountWei'], '80000000000000000')
                self.assertNotIn('totalAmountWei', [q['field'] for q in result['questions']])
            if index >= 2:
                self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']], ['20000000000000000'] * 4)
                self.assertEqual({q['field'] for q in result['questions']}, {'clientWallet', 'developerWallet'})
            self.record(history, message, result, 'totalAmountWei' if index == 0 else 'milestones' if index == 1 else 'clientWallet')
            prior = result['draftSpec']

    def test_old_finance_draft_recovers_historical_allocations_and_aliases(self):
        history, previous = self.legacy()
        terms = self.terms('0.08 ETH', ['25% of 0.08 ETH', '0.02', '0.02', '0.02'])
        terms['questions'] = [dict(field=f'milestones.{n}.amount', kind='missing', sourceQuote=None,
                                  question=f'What amount should be allocated to milestone {n} ({FINANCE_TITLES[n - 1]})?')
                              for n in range(2, 5)]
        result = clarify(dict(message=FINANCE_MESSAGES[4], history=history, draftSpec=previous['draftSpec']), lambda *_: terms)
        self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']], ['20000000000000000'] * 4)
        self.assertEqual({q['field'] for q in result['questions']}, {'clientWallet', 'developerWallet'})

    def test_bare_total_requires_one_explicit_displayed_unit(self):
        for unit_question, expected in [('What total amount in ETH?', '80000000000000000'),
                                       ('What total amount?', None), ('What total amount in ETH or wei?', None),
                                       ('What total amount in USD?', None)]:
            with self.subTest(question=unit_question):
                first = clarify(dict(message=FINANCE_MESSAGES[0], history=[], draftSpec=None), lambda *_: self.terms())
                history = [dict(role='user', content=FINANCE_MESSAGES[0]), dict(role='assistant', content=json.dumps(
                    dict(result=first, question=dict(field='totalAmountWei', question=unit_question))))]
                result = clarify(dict(message='0.08', history=history, draftSpec=first['draftSpec']), lambda *_: self.terms())
                self.assertEqual(result['draftSpec']['totalAmountWei'], expected)

    def test_percentage_expressions_use_only_the_agreed_basis(self):
        total = '80000000000000000'
        for quote, source, expected in [
            ('25%', FINANCE_MESSAGES[4], '20000000000000000'),
            ('25% of 0.08 ETH', FINANCE_MESSAGES[4], '20000000000000000'),
            ('25%', '25% of the total', '20000000000000000'),
            ('25% of the total', '25% of the total', '20000000000000000'),
            ('25%', '25% of 0.10 ETH', None),
            ('25% of 0.10 ETH', '25% of 0.10 ETH', None),
            ('25%', '25% of the remaining balance', None),
        ]:
            with self.subTest(quote=quote, source=source):
                self.assertEqual(value_of(quote, ['Previously 25% was proposed.', source], set(), total), expected)
        self.assertIsNone(value_of('25%', ['25% of 3 wei'], set(), '3'))

    def test_unchanged_verified_stages_survive_partial_or_normalized_extraction(self):
        for omitted in (None, '0.020 ETH'):
            with self.subTest(amount=omitted):
                history, previous = self.legacy(complete=True)
                terms = self.terms('0.08 ETH', ['25% of 0.08 ETH', omitted, omitted, omitted])
                terms['milestones'][1]['title'] = '  Chat  Bot Section '
                terms['changedFields'] = [dict(field='milestones.1.amountWei', userQuote=FINANCE_MESSAGES[4])]
                terms['questions'] = [dict(field=f'milestones.{n}.amountWei', kind='missing', sourceQuote=None,
                                          question='Please give this installment amount again.') for n in range(2, 5)]
                result = clarify(dict(message=FINANCE_MESSAGES[4], history=history, draftSpec=previous['draftSpec']), lambda *_: terms)
                self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']], ['20000000000000000'] * 4)
                self.assertEqual({q['field'] for q in result['questions']}, {'clientWallet', 'developerWallet'})

    def test_wallet_only_reply_keeps_verified_amounts_without_change_metadata(self):
        client, provider = '0x' + '1' * 40, '0x' + '2' * 40
        for message, kept in [
            (f'For this local test, use {client} as the client wallet and {provider} as the developer wallet.', True),
            (f'Use {client} and {provider}. The chat bot price is changing.', False),
        ]:
            with self.subTest(message=message):
                history, previous = self.legacy(complete=True)
                terms = self.terms(None, [None] * 4)
                terms.update(clientWallet=client, developerWallet=provider, resolvedQuestions=[
                    dict(field='clientWallet', userQuote=client), dict(field='developerWallet', userQuote=provider)])
                terms.pop('changedFields')
                result = clarify(dict(message=message, history=history, draftSpec=previous['draftSpec']), lambda *_: terms)
                amounts = [m['amountWei'] for m in result['draftSpec']['milestones']]
                self.assertEqual(amounts, ['20000000000000000'] * 4 if kept else [None] * 4)
                self.assertEqual(result['status'], 'readyForConfirmation' if kept else 'needsClarification')

    def test_wallet_reply_resolves_wallet_questions_and_keeps_amounts_despite_model_claims(self):
        client, provider = '0x' + '1' * 40, '0x' + '2' * 40
        history, previous = self.legacy(complete=True)
        message = f'For this local test, use {client} as the client wallet and {provider} as the developer wallet.'
        terms = self.terms('0.08 ETH', ['25%'] * 4)
        terms.update(clientWallet=client, developerWallet=provider)
        # The model claims every amount changed and still asks for the provider wallet.
        terms['changedFields'] = [dict(field=f'milestones.{n}.amountWei', userQuote='For this local test')
                                  for n in range(1, 5)]
        terms['questions'] = [dict(field='developerWallet', kind='semantic', sourceQuote=None,
                                   question='Which wallet receives the provider payments?'),
                              dict(field='milestones.2.amountWei', kind='semantic', sourceQuote=None,
                                   question='Is the chat bot amount still agreed?')]
        result = clarify(dict(message=message, history=history, draftSpec=previous['draftSpec']), lambda *_: terms)
        self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']], ['20000000000000000'] * 4)
        self.assertEqual(result['draftSpec']['totalAmountWei'], '80000000000000000')
        self.assertEqual(result['questions'], [])
        self.assertEqual(result['status'], 'readyForConfirmation')

    def test_real_contract_output_is_cleaned_instead_of_failing_the_turn(self):
        case = example('complete')
        payload, terms = case['request']['payload'], case['exampleExtraction']
        long_title = 'Stages 3 through 6: front-end development, back-end development and CMS integration, ' \
                     'testing and deployment, and post-launch support'
        terms['name'] = 'Website Development Agreement between Northbeam Digital Limited and Calder Goods Inc. ' * 2
        terms['milestones'][1]['title'] = long_title
        terms['separateTerms'] = ['A paraphrase the user never wrote.']
        terms['resolvedQuestions'] = [{'field': 'clientWallet'}, 'not an object']
        terms['changedFields'] = 'everything'
        result = clarify(payload, lambda *_: terms)
        self.assertLessEqual(len(result['draftSpec']['name']), 120)
        title = result['draftSpec']['milestones'][1]['title']
        self.assertLessEqual(len(title), 120)
        self.assertTrue(title.startswith('Stages 3 through 6: front-end development') and title.endswith('\u2026'))
        self.assertEqual(result['separateTerms'], [])

    def test_percentage_expression_may_restate_a_listed_percentage(self):
        total = '20000000000000000'
        source = 'The split is 25%, 25% and 50% of 0.02 ETH, in that order.'
        self.assertEqual(value_of('25% of 0.02 ETH', [source], set(), total), '5000000000000000')
        self.assertEqual(value_of('50% of 0.02 ETH', [source], set(), total), '10000000000000000')
        self.assertIsNone(value_of('25% of 0.03 ETH', [source], set(), total))
        self.assertIsNone(value_of('30% of 0.02 ETH', [source], set(), total))

    def test_changes_conflicts_new_identity_and_unverified_quotes_disable_retention(self):
        for mode in ('price_change', 'conflict', 'rename', 'reorder', 'bad_quote'):
            with self.subTest(mode=mode):
                history, previous = self.legacy(complete=True)
                terms = self.terms('0.08 ETH', ['25% of 0.08 ETH', None, None, None])
                message = FINANCE_MESSAGES[4] + ' Change the chat bot payment; its new amount is undecided.'
                if mode == 'price_change':
                    terms['changedFields'] = [dict(field='milestones.2.amountWei', userQuote='Change the chat bot payment')]
                elif mode == 'conflict':
                    terms['questions'] = [dict(field='milestones.2.amountWei', kind='conflict',
                                              sourceQuote='its new amount is undecided', question='Which new chat bot price is agreed?')]
                elif mode == 'rename':
                    terms['milestones'][1]['title'] = 'analytics dashboard'
                elif mode == 'reorder':
                    terms['milestones'][1], terms['milestones'][2] = terms['milestones'][2], terms['milestones'][1]
                else:
                    terms['changedFields'] = [dict(field='milestones.2.amountWei', userQuote='An invented paraphrase')]
                result = clarify(dict(message=message, history=history, draftSpec=previous['draftSpec']), lambda *_: terms)
                self.assertIsNone(result['draftSpec']['milestones'][1]['amountWei'])
                self.assertEqual(result['status'], 'needsClarification')

    def test_prior_conflict_cannot_be_reclassified_as_missing_on_unrelated_turns(self):
        history, previous = self.legacy()
        conflict = dict(field='milestones.1.amountWei', question='The homepage has two proposed prices. Which is agreed?')
        previous['questions'] = [conflict]
        history[-1]['content'] = json.dumps(dict(result=previous, question=conflict))
        for _ in range(2):
            terms = self.terms('0.08 ETH', ['0.02'] * 4)
            terms['questions'] = [dict(field='milestones.1.amountWei', kind='missing', sourceQuote=None,
                                      question='Please give the first amount again.')]
            message = 'Keep the same wallet.'
            result = clarify(dict(message=message, history=history, draftSpec=previous['draftSpec']), lambda *_: terms)
            self.assertIn(conflict, result['questions'])
            self.assertEqual(result['status'], 'needsClarification')
            self.record(history, message, result, 'milestones.1.amountWei')
            previous = result
