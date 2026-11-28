import copy
import json
import unittest
from pathlib import Path

from agent1.review import parse_duration, parse_limit
from agent1.service import clarify

DAY = 86400
CLAUSE = (' Each deliverable is deemed accepted if the Client submits no Change Request within ten (10) days'
          ' of delivery. The Client may request up to two (2) rounds of revisions per deliverable.')


def example():
    return json.loads((Path(__file__).parent / 'examples' / 'complete.json').read_text())


class ParseTests(unittest.TestCase):
    def test_durations_as_written_in_contracts_and_chat(self):
        cases = {'ten (10) days': 10 * DAY, '14 days': 14 * DAY, 'two weeks': 14 * DAY, '48 hours': 2 * DAY,
                 '7天': 7 * DAY, '七天': 7 * DAY, '两周': 14 * DAY, 'a week': 7 * DAY,
                 'twenty-one days': 21 * DAY, '30 minutes': 1800}
        for quote, seconds in cases.items():
            with self.subTest(quote=quote):
                self.assertEqual(parse_duration(quote), seconds)

    def test_business_days_never_shorten_the_review(self):
        self.assertEqual(parse_duration('5 business days'), 7 * DAY)
        self.assertEqual(parse_duration('10 working days'), 14 * DAY)
        self.assertEqual(parse_duration('15个工作日'), 21 * DAY)

    def test_unclear_or_out_of_range_durations_are_not_guessed(self):
        for quote in ['a reasonable time', '10 days or 5 days', '91 days', '20 seconds', '', None]:
            with self.subTest(quote=quote):
                self.assertIsNone(parse_duration(quote))

    def test_change_request_limits(self):
        self.assertEqual(parse_limit('up to two (2) rounds of revisions'), 2)
        self.assertEqual(parse_limit('最多修改3次'), 3)
        self.assertEqual(parse_limit('unlimited revisions'), 0)
        self.assertIsNone(parse_limit('25 rounds'))
        self.assertIsNone(parse_limit('some revisions'))


class ReviewDraftTests(unittest.TestCase):
    def setUp(self):
        case = example()
        self.payload = case['request']['payload']
        self.payload['message'] += CLAUSE
        self.terms = case['exampleExtraction']

    def run_turn(self, payload, **extra):
        terms = dict(copy.deepcopy(self.terms), **extra)
        return clarify(payload, lambda *_: copy.deepcopy(terms))

    def follow_up(self, first, message):
        return dict(draftSpec=first['draftSpec'], message=message,
                    history=[dict(role='user', content=self.payload['message']),
                             dict(role='assistant', content=json.dumps(first))])

    def test_deemed_acceptance_becomes_the_review_period_not_a_note(self):
        result = self.run_turn(self.payload, reviewPeriodQuote='ten (10) days',
                               changeRequestLimitQuote='up to two (2) rounds of revisions',
                               unsupportedTerms=['deemed acceptance if no Change Request within ten days'])
        self.assertEqual(result['status'], 'readyForConfirmation')
        self.assertEqual(result['draftSpec']['reviewPeriodSeconds'], 10 * DAY)
        self.assertEqual(result['draftSpec']['changeRequestLimit'], 2)
        self.assertNotIn('notEnforced', result)

    def test_no_clause_means_no_review_period(self):
        result = self.run_turn(self.payload, reviewPeriodQuote=None)
        self.assertNotIn('reviewPeriodSeconds', result['draftSpec'])

    def test_an_invented_quote_is_ignored(self):
        result = self.run_turn(self.payload, reviewPeriodQuote='30 days')
        self.assertNotIn('reviewPeriodSeconds', result['draftSpec'])

    def test_an_unreadable_time_stays_a_visible_note(self):
        self.payload['message'] += ' Silence for a reasonable time counts as acceptance.'
        result = self.run_turn(self.payload, reviewPeriodQuote='a reasonable time')
        self.assertNotIn('reviewPeriodSeconds', result['draftSpec'])
        self.assertEqual(result['notEnforced'], ['automatic acceptance after a reasonable time'])

    def test_kept_across_unrelated_turns_and_removed_when_asked(self):
        first = self.run_turn(self.payload, reviewPeriodQuote='ten (10) days')
        later = self.run_turn(self.follow_up(first, 'Rename it to Shop website.'), name='Shop website')
        self.assertEqual(later['draftSpec']['reviewPeriodSeconds'], 10 * DAY)
        self.assertEqual(later['draftSpec']['specVersion'], 2)
        removed = self.run_turn(self.follow_up(first, 'No automatic payment: the client approves every payment.'))
        self.assertNotIn('reviewPeriodSeconds', removed['draftSpec'])
        self.assertNotIn('changeRequestLimit', removed['draftSpec'])

    def test_the_review_page_option_adds_fourteen_days(self):
        first = self.run_turn(self.payload)
        option = 'If the client does not respond within 14 days after a delivery, release that payment automatically.'
        added = self.run_turn(self.follow_up(first, option), reviewPeriodQuote='14 days')
        self.assertEqual(added['draftSpec']['reviewPeriodSeconds'], 14 * DAY)
        self.assertEqual(added['draftSpec']['changeRequestLimit'], 0)


if __name__ == '__main__':
    unittest.main()
