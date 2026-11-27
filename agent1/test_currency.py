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



class EverydayRequestTests(unittest.TestCase):
    """Requests written the way first-time users wrote them in the live run."""

    def run_case(self, message, total, amounts, history=(), draft=None, rates=None):
        terms = dict(separateTerms=[], name='Request', clientWallet=None, developerWallet=None, total=total,
                     milestones=[dict(title=f'Step {i}', amount=a) for i, a in enumerate(amounts, 1)],
                     revisionRiskOpen=False, withdrawals=[], questions=[], unsupportedTerms=[], resolvedQuestions=[])
        with patch.object(currency, 'live_prices', return_value=market(rates or {'USD': '1667.36', 'CNY': '11103.25',
                                                                                  'GBP': '1271.31'})):
            return clarify(dict(message=message, history=list(history), draftSpec=draft), lambda *_: terms)

    def amounts(self, result):
        return [int(m['amountWei']) if m['amountWei'] else None for m in result['draftSpec']['milestones']]

    def test_chinese_numerals_and_the_rest(self):
        message = '\u6211\u5bb6\u53a8\u623f\u8981\u7ffb\u65b0\uff0c\u5e08\u5085\u62a5\u4ef73\u4e078\uff0c\u5f00\u5de5\u5148\u4ed8\u4e00\u4e07\uff0c\u6c34\u7535\u505a\u5b8c\u4ed8\u4e00\u4e07\u4e94\uff0c\u5b8c\u5de5\u9a8c\u6536\u540e\u4ed8\u5269\u4e0b\u7684\u3002'
        # The model's actual quotes: it translated 剩下的 into English.
        result = self.run_case(message, '3\u4e078', ['\u4e00\u4e07', '\u4e00\u4e07\u4e94', 'the remaining balance'])
        amounts = self.amounts(result)
        self.assertEqual(sum(amounts), int(result['draftSpec']['totalAmountWei']))
        # 10,000 and 15,000 of 38,000 yuan; the rest is 13,000.
        self.assertAlmostEqual(amounts[2] / amounts[0], 1.3, places=4)
        self.assertEqual(result['exchangeRates'][0]['currency'], 'CNY')

    def test_count_times_unit_price_and_chinese_halves(self):
        message = '\u7ed9\u5b69\u5b50\u8bf7\u4e86\u4e2a\u6570\u5b66\u5bb6\u6559\uff0c\u4e00\u517120\u8282\u8bfe\uff0c\u6bcf\u8282300\u5757\uff0c\u4e0a\u5b8c10\u8282\u4ed8\u4e00\u534a\uff0c\u5168\u90e8\u4e0a\u5b8c\u4ed8\u53e6\u4e00\u534a\u3002'
        result = self.run_case(message, '20 \u00d7 300\u5757', ['half', 'the remaining balance'])
        amounts = self.amounts(result)
        self.assertEqual(amounts[0], amounts[1])
        # 6,000 yuan at 11,103.25 yuan per ETH.
        self.assertEqual(int(result['draftSpec']['totalAmountWei']), 540382000000000000)

    def test_share_words_followed_by_their_condition(self):
        message = "Hiring a freelancer to redo my restaurant website. $2,400 total \u2014 half upfront, rest when it's live."
        result = self.run_case(message, '$2,400', ['half upfront', 'the rest'])
        amounts = self.amounts(result)
        # Halves of a converted total differ by at most the 6-decimal rounding step.
        self.assertLessEqual(abs(amounts[0] - amounts[1]), currency.STEP)
        self.assertEqual(sum(amounts), int(result['draftSpec']['totalAmountWei']))
        self.assertEqual(result['status'], 'needsClarification')  # only the wallets are left
        self.assertEqual({q['field'] for q in result['questions']}, {'clientWallet', 'developerWallet'})

    def test_running_total_percentages_from_a_procurement_contract(self):
        # Shanghai government procurement contract (public record), payment clause as printed.
        message = ('2.2 \u5408\u540c\u91d1\u989d\uff1a\u4eba\u6c11\u5e01 7270988\u3002\n5.2 \u4ed8\u6b3e\u65b9\u5f0f\n'
                   '1\uff09\u81ea\u5408\u540c\u7b7e\u8ba2\u540e\uff0c\u7532\u65b9\u5411\u4e59\u65b9\u652f\u4ed8\u672c\u5408\u540c\u4ef7\u7684 10%\uff1b\n'
                   '2\uff09\u9879\u76ee\u5b8c\u5de5\u9a8c\u6536\u5408\u683c\u540e\uff0c\u7532\u65b9\u5411\u4e59\u65b9\u652f\u5408\u540c\u4ef7 50% \uff1b\n'
                   '3\uff09\u9879\u76ee\u5b8c\u6210\u5ba1\u4ef7\u540e\uff0c\u7532\u65b9\u5411\u4e59\u65b9\u652f\u4ed8\u81f3\u5ba1\u5b9a\u4ef7\u7684 97% \uff1b\n'
                   '4\uff09\u8d28\u4fdd\u671f\u6ee1\u540e\uff0c\u7532\u65b9\u5411\u4e59\u65b9\u652f\u4ed8\u5269\u4f59\u5c3e\u6b3e\u3002')
        result = self.run_case(message, '\u4eba\u6c11\u5e01 7270988', ['10%', '50%', '97%', '\u5269\u4f59\u5c3e\u6b3e'])
        amounts = self.amounts(result)
        total = int(result['draftSpec']['totalAmountWei'])
        self.assertEqual(sum(amounts), total)
        # "\u652f\u4ed8\u81f3 ... 97%" brings payments to 97%: this milestone adds 37%; the final 3% is the rest.
        self.assertAlmostEqual(amounts[2] / total, 0.37, places=5)
        self.assertAlmostEqual(amounts[3] / total, 0.03, places=5)

    def test_running_totals_in_english_and_a_plain_percentage_that_is_not_one(self):
        from agent1.service import cumulative_share
        self.assertEqual(cumulative_share('90%', ['Pay 30% on signing; on acceptance, bringing total payments to 90%.']), 90)
        self.assertIsNone(cumulative_share('30%', ['\u5408\u540c\u7b7e\u8ba2\u540e\u81f3\u5f00\u5de5\u524d\u652f\u4ed830%']))
        self.assertIsNone(cumulative_share('50%', ['Pay 50% on delivery.']))

    def test_a_share_word_counts_only_as_a_whole_word_the_user_wrote(self):
        from agent1.service import natural_word
        self.assertIsNone(natural_word('the rest', ['Redo my restaurant website for $2,400.']))
        self.assertEqual(natural_word('the rest', ["half upfront, rest when it's live"]), ('rest', None))
        self.assertEqual(natural_word('half', ['\u4e0a\u5b8c10\u8282\u4ed8\u4e00\u534a']), ('fraction', (1, 2)))
        self.assertIsNone(natural_word('half', ['Pay $500 now and $700 later.']))

    def test_an_amount_quoted_with_a_word_and_the_rest(self):
        message = 'Wedding photographer, \u00a31,800. \u00a3500 deposit to book the date, the rest after we get the edited photos.'
        result = self.run_case(message, '\u00a31,800', ['\u00a3500 deposit', 'the rest after we get the edited photos'])
        amounts = self.amounts(result)
        self.assertEqual(sum(amounts), int(result['draftSpec']['totalAmountWei']))
        self.assertAlmostEqual(amounts[1] / amounts[0], 2.6, places=4)

    def test_about_an_amount_in_words(self):
        result = self.run_case("about 2000 dollars, pay when it's done", 'about 2000 dollars', ['about 2000 dollars'])
        self.assertTrue(result['draftSpec']['totalAmountWei'])

    def test_a_bare_number_reply_uses_the_agreement_currency(self):
        first = 'Website for $2,400: a first payment, and the rest at launch.'
        opened = self.run_case(first, '$2,400', [None, 'the rest'])
        question = dict(field='milestones.1.amountWei', question='How much is paid for milestone 1? Give an amount in USD.')
        history = [dict(role='user', content=first),
                   dict(role='assistant', content=json.dumps(dict(result=opened, question=question)))]
        result = self.run_case('800', '$2,400', ['800', 'the rest'], history=history, draft=opened['draftSpec'])
        amounts = self.amounts(result)
        self.assertEqual(amounts[0] + amounts[1], int(result['draftSpec']['totalAmountWei']))
        self.assertAlmostEqual(amounts[1] / amounts[0], 2, places=4)

    def test_chinese_and_everyday_amount_phrases(self):
        cases = {'3\u4e078': ('CNY', 38000), '\u4e00\u4e07\u4e94': ('CNY', 15000), '\u5341\u4e07': ('CNY', 100000),
                 '\u4e09\u4e07\u516b\u5343\u5143': ('CNY', 38000), '\u00a3500 deposit': ('GBP', 500),
                 'about 2000 dollars': ('USD', 2000)}
        for text, (code, value) in cases.items():
            with self.subTest(text=text):
                self.assertEqual(currency.parse(text), (code, Fraction(value)))
        for text in ('\u4e00\u534a', '\u53e6\u4e00\u534a', '$500 per month', '\u6bcf\u8282300\u5757'):
            with self.subTest(text=text):
                self.assertIsNone(currency.parse(text))

if __name__ == '__main__':
    unittest.main()
