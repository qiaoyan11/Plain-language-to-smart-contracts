import json
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch

from agent1 import currency
from agent1.service import clarify, value_of


def market(prices, provider='CoinGecko', stale=False):
    return {'prices': {code: Fraction(value) for code, value in prices.items()}, 'provider': provider,
            'asOf': '2026-11-27T17:40:00Z', 'stale': stale}


class ParseTests(unittest.TestCase):
    def test_everyday_amounts_in_english_and_chinese(self):
        cases = {'USD $8,000': ('USD', 8000), '$5k': ('USD', 5000), '1,800 dollars': ('USD', 1800),
                 'RMB 89,800': ('CNY', 89800), '人民币 89,800 元': ('CNY', 89800),
                 '8.98万元': ('CNY', 89800), '500块': ('CNY', 500), '€1,200.50': ('EUR', Fraction(240100, 200)),
                 '¥150,000 JPY': ('JPY', 150000), 'HK$7,800': ('HKD', 7800), '£950': ('GBP', 950)}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(currency.parse(text), (expected[0], Fraction(expected[1])))

    def test_text_that_is_not_one_amount_is_left_to_the_conversation(self):
        for text in ('$8,000 for stage 2', '8 ETH', '500', '$500 or $600', '30%'):
            with self.subTest(text=text):
                self.assertIsNone(currency.parse(text))

    def test_rates_the_parties_state_win_and_the_latest_one_counts(self):
        sources = ['Pay in test ETH at 1 ETH = 1,000 USD.', '按 1 ETH = 20,000 元人民币换算',
                   'Actually $2,000 = 1 ETH.']
        self.assertEqual(currency.stated_rates(sources), {'USD': 2000, 'CNY': 20000})


class LivePriceTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        patcher = patch.object(currency, 'CACHE', Path(folder.name) / 'rates.json')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_live_price_is_cached_and_the_second_provider_covers_an_outage(self):
        calls = []
        def get(url):
            calls.append(url)
            if 'coingecko' in url:
                raise OSError('offline')
            return {'data': {'rates': {'USD': '1667.36', 'CNY': '11103.25', 'BTC': '0.02'}}}
        first = currency.live_prices(get=get, now=lambda: 1000.0)
        self.assertEqual(first['provider'], 'Coinbase')
        self.assertEqual(first['prices']['USD'], Fraction('1667.36'))
        self.assertNotIn('BTC', first['prices'])
        again = currency.live_prices(get=lambda url: self.fail('cached'), now=lambda: 1300.0)
        self.assertEqual(again['prices'], first['prices'])
        stale = currency.live_prices(get=lambda url: (_ for _ in ()).throw(OSError()), now=lambda: 5000.0)
        self.assertTrue(stale['stale'])
        self.assertEqual(len(calls), 2)

    def test_no_live_or_cached_price_falls_back_to_the_reference_table(self):
        with patch.object(currency, 'live_prices', return_value=None):
            book = currency.RateBook(['Logo for $500'], live=True)
            value, record = book.price('USD')
        self.assertEqual(record['source'], 'reference')
        self.assertEqual(value, Fraction(currency.REFERENCE_PRICES['USD']))


class ConversionTests(unittest.TestCase):
    def terms(self, total, amounts, name='Logo design'):
        return dict(separateTerms=[], name=name, clientWallet=None, developerWallet=None, total=total,
                    milestones=[dict(title=f'Step {i}', amount=a) for i, a in enumerate(amounts, 1)],
                    revisionRiskOpen=False, withdrawals=[], questions=[], unsupportedTerms=[], resolvedQuestions=[])

    def test_prices_in_dollars_are_converted_at_the_live_rate_without_a_question(self):
        message = 'Hire a designer for a logo, $500, paid when I approve the final files.'
        with patch.object(currency, 'live_prices', return_value=market({'USD': '1667.36'})):
            result = clarify(dict(message=message, history=[], draftSpec=None),
                             lambda *_: self.terms('$500', ['$500']))
        # 500 / 1667.36 = 0.29987525... ETH, rounded to six decimals.
        self.assertEqual(result['draftSpec']['totalAmountWei'], '299875000000000000')
        self.assertEqual(result['draftSpec']['milestones'][0]['amountWei'], '299875000000000000')
        self.assertEqual(result['exchangeRates'], [{'currency': 'USD', 'unitsPerEth': '1667.36', 'source': 'live',
                                                    'asOf': '2026-11-27T17:40:00Z', 'provider': 'CoinGecko'}])
        self.assertFalse([q for q in result['questions'] if 'amount' in q['field'].lower()])

    def test_the_rate_is_kept_for_the_rest_of_the_conversation(self):
        message = 'Pay $500 when I approve the final logo files.'
        with patch.object(currency, 'live_prices', return_value=market({'USD': '1667.36'})):
            first = clarify(dict(message=message, history=[], draftSpec=None), lambda *_: self.terms('$500', ['$500']))
        history = [dict(role='user', content=message), dict(role='assistant', content=json.dumps(first))]
        with patch.object(currency, 'live_prices', side_effect=AssertionError('the locked rate is reused')):
            second = clarify(dict(message='The logo should be a fox, $500 as agreed.', history=history,
                                  draftSpec=first['draftSpec']), lambda *_: self.terms('$500', ['$500']))
        self.assertEqual(second['draftSpec']['totalAmountWei'], first['draftSpec']['totalAmountWei'])
        self.assertEqual(second['exchangeRates'], first['exchangeRates'])

    def test_rounded_renminbi_installments_still_add_up_to_the_contract_total(self):
        message = ('基本服务费 89,800 元，分三期：26,940 元、'
                   '35,920 元、26,940 元。')
        with patch.object(currency, 'live_prices', return_value=market({'CNY': '11103.25'})):
            result = clarify(dict(message=message, history=[], draftSpec=None), lambda *_: self.terms(
                '89,800 元', ['26,940 元', '35,920 元', '26,940 元'], name='Career consulting'))
        spec = result['draftSpec']
        self.assertEqual(sum(int(m['amountWei']) for m in spec['milestones']), int(spec['totalAmountWei']))
        self.assertFalse([q for q in result['questions'] if q['field'] == 'totalAmountWei'])
        self.assertEqual(result['exchangeRates'][0]['currency'], 'CNY')

    def test_a_stated_rate_replaces_the_live_one(self):
        message = 'Website for $24,000 at 1 ETH = 1,000 USD: $8,000 for design, $16,000 for the build.'
        with patch.object(currency, 'live_prices', return_value=market({'USD': '1667.36'})):
            result = clarify(dict(message=message, history=[], draftSpec=None),
                             lambda *_: self.terms('$24,000', ['$8,000', '$16,000'], name='Website'))
        self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']],
                         ['8000000000000000000', '16000000000000000000'])
        self.assertEqual(result['exchangeRates'][0]['source'], 'stated')

    def test_percentages_of_a_total_in_another_currency(self):
        with patch.object(currency, 'live_prices', return_value=None):
            total = value_of('$1,000', ['Total $1,000: 30% on design.'], set())
            self.assertEqual(value_of('30% of $1,000', ['Total $1,000: 30% of $1,000 on design.'], set(), total),
                             str(int(total) * 3 // 10))


class NaturalShareTests(unittest.TestCase):
    def run_case(self, message, total, amounts, name='Video edit'):
        terms = dict(separateTerms=[], name=name, clientWallet=None, developerWallet=None, total=total,
                     milestones=[dict(title=f'Step {i}', amount=a) for i, a in enumerate(amounts, 1)],
                     revisionRiskOpen=False, withdrawals=[], questions=[], unsupportedTerms=[], resolvedQuestions=[])
        return clarify(dict(message=message, history=[], draftSpec=None), lambda *_: terms)

    def test_half_now_and_the_rest_on_delivery(self):
        result = self.run_case('1.8 ETH total, half upfront and the rest when all episodes are delivered.',
                               '1.8 ETH', ['half', 'the rest'])
        self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']],
                         ['900000000000000000', '900000000000000000'])
        self.assertFalse([q for q in result['questions'] if 'amountWei' in q['field']])

    def test_equal_installments_and_chinese_shares(self):
        result = self.run_case('Three equal payments, 1 ETH in total.', '1 ETH', ['equal', 'equal', 'equal'])
        amounts = [int(m['amountWei']) for m in result['draftSpec']['milestones']]
        self.assertEqual(sum(amounts), 10**18)
        self.assertEqual(amounts[:2], [333333000000000000] * 2)
        result = self.run_case('总共 2 ETH，先付一半，尾款验收后付。',
                               '2 ETH', ['一半', '尾款'])
        self.assertEqual([m['amountWei'] for m in result['draftSpec']['milestones']],
                         ['1000000000000000000', '1000000000000000000'])

    def test_a_share_word_the_user_never_wrote_is_not_evidence(self):
        result = self.run_case('1 ETH in total for two stages.', '1 ETH', ['half', 'the rest'])
        self.assertIn('milestones.1.amountWei', [q['field'] for q in result['questions']])

    def test_a_missing_title_gets_a_name_instead_of_a_question(self):
        result = self.run_case('Pay 1 ETH when the logo is approved.', '1 ETH', ['1 ETH'], name=None)
        self.assertNotIn('name', [q['field'] for q in result['questions']])
        self.assertEqual(result['draftSpec']['name'], 'Service agreement')


if __name__ == '__main__':
    unittest.main()
