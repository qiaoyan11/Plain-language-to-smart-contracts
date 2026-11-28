"""Convert amounts written in ordinary currencies to test ETH at the live ETH price.

Users describe prices the way they think of them ("$500", "8.98万元", "€1,200"). Agent 1 quotes
the amount; this module converts it to wei, so nobody has to work out an ETH figure:

1. A rate the parties state in the conversation ("1 ETH = 20,000 RMB") wins.
2. Otherwise the rate already used earlier in the same draft is kept, so amounts do not drift
   from turn to turn while the user is still answering questions.
3. Otherwise the live ETH price (CoinGecko, then Coinbase), cached for ten minutes.
4. If no live price is reachable, the last cached price, then a fixed reference table; the
   result says which one was used.

ACCORD_RATES=reference skips the network (offline demos and tests). ACCORD_ETH_PRICES (JSON,
units of each currency per ETH) replaces reference values.
"""
import contextvars
import json
import os
import re
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path

WEI = 10**18
# Converted amounts are rounded to 6 decimal places of ETH (10**12 wei).
STEP = 10**12
CACHE_SECONDS = 600
CACHE = Path(__file__).resolve().parents[1] / 'data' / 'private' / 'exchange-rates.json'

# Units of each currency per ETH, used only when no live or cached price exists (late 2026 levels).
REFERENCE_PRICES = {
    'USD': '1670', 'CNY': '11100', 'EUR': '1520', 'GBP': '1270', 'HKD': '13050', 'JPY': '266000',
    'CAD': '2300', 'AUD': '2540', 'SGD': '2160', 'INR': '140000', 'KRW': '2300000', 'CHF': '1470',
}
CODES = tuple(REFERENCE_PRICES)

# Currency markers, most specific first: "HK$" before "$", "美元" before "元".
def _ascii(word):
    return r'(?<![A-Za-z])(?:' + word + r')(?![A-Za-z])'


MARKERS = [
    (r'HK\$', 'HKD'), (r'US\$', 'USD'), (r'CA?\$', 'CAD'), (r'AU?\$', 'AUD'), (r'S\$', 'SGD'),
    (_ascii('|'.join(CODES) + '|RMB'), None),
    (_ascii(r'(?:US\s+)?dollars?|bucks'), 'USD'), (_ascii('euros?'), 'EUR'),
    (_ascii(r'pounds?(?:\s+sterling)?'), 'GBP'), (_ascii('yuan|renminbi'), 'CNY'), (_ascii('yen'), 'JPY'),
    (_ascii('rupees?'), 'INR'), (_ascii('won'), 'KRW'), (_ascii('francs?'), 'CHF'),
    ('美元|美金', 'USD'), ('欧元', 'EUR'), ('英镑', 'GBP'),
    ('港币|港元', 'HKD'), ('日元|日币|円', 'JPY'),
    ('人民币|块钱|块|元', 'CNY'),
    (r'\$', 'USD'), ('[￥¥]', 'CNY'), ('€', 'EUR'), ('£', 'GBP'), ('₹', 'INR'),
    ('₩', 'KRW'),
]
_ANY_MARKER = '|'.join(f'(?:{pattern})' for pattern, _ in MARKERS)
_NUMBER = r'[0-9]{1,3}(?:[,，][0-9]{3})+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?'
_SCALE = r'k|thousand|million|万|千'
NUM = re.compile(rf'(?<![0-9.,])(?P<num>{_NUMBER})(?:\s*(?P<scale>{_SCALE})(?![A-Za-z]))?', re.I)
SCALES = {'k': 1000, 'thousand': 1000, 'million': 10**6, '万': 10**4, '千': 1000}


CN_DIGITS = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
             '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
CN_SMALL = {'十': 10, '百': 100, '千': 1000}
CN_BIG = {'万': 10**4, '亿': 10**8}
_CN_ALL = ''.join(CN_DIGITS) + ''.join(CN_SMALL) + ''.join(CN_BIG)
# "3万8", "一万五", "3.8万", "三万八千", "十万": digits mixed with Chinese numerals and units.
CN_NUMBER = re.compile(r'(?:[0-9]+(?:\.[0-9]+)?|[' + _CN_ALL + r'])[0-9.' + _CN_ALL + r']*')
# Words that make an amount a rate or a unit price, which is not one payment.
NOT_ONE_AMOUNT = re.compile(r'(?<![A-Za-z])(?:per|each|every)(?![A-Za-z])|/\s*(?:h|hr|hour|day|week|month|mo|year|yr)\b'
                            r'|每', re.I)


def chinese_number(text):
    """Value of a Chinese or mixed number; the colloquial "3万8" is 38,000 and "一万五" 15,000."""
    total, section, number, last = Fraction(0), Fraction(0), None, None
    for token in re.findall(r'[0-9]+(?:\.[0-9]+)?|.', text):
        if token[0].isdigit():
            number = Fraction(Decimal(token))
        elif token in CN_DIGITS:
            number = Fraction(CN_DIGITS[token])
        elif token in CN_SMALL:
            section += (number if number is not None else 1) * CN_SMALL[token]
            number, last = None, CN_SMALL[token]
        elif token in CN_BIG:
            section += number if number is not None else 0
            total += (section or 1) * CN_BIG[token]
            section, number, last = Fraction(0), None, CN_BIG[token]
        else:
            return None
    if number is not None:
        # A digit after the last unit counts one unit lower: "3万8" means 3万8千.
        section += number * last / 10 if last and last >= 100 else number
    value = total + section
    return value if value > 0 else None


def _amount_and_rest(text):
    """(value, text around it, written in Chinese) for the one amount in text, else None."""
    chinese = [m for m in CN_NUMBER.finditer(text) if re.search('[' + _CN_ALL + ']', m.group())]
    if len(chinese) == 1:
        found = chinese[0]
        others = NUM.findall(text[:found.start()] + ' ' + text[found.end():])
        value = chinese_number(found.group()) if not others else None
        return (value, text[:found.start()] + ' ' + text[found.end():], True) if value else None
    if chinese:
        return None
    numbers = list(NUM.finditer(text))
    if len(numbers) != 1:
        return None
    number = numbers[0]
    try:
        amount = Decimal(number['num'].replace(',', '').replace('，', ''))
    except InvalidOperation:
        return None
    if number['scale']:
        amount *= SCALES[number['scale'].lower()]
    return Fraction(amount), text[:number.start()] + ' ' + text[number.end():], False


def parse(text):
    """(currency, amount) for a quote naming one amount, such as "USD $8,000", "£500 deposit",
    "about 2000 dollars" or "3万8"; None for anything else (two numbers, a unit price, no currency)."""
    if not isinstance(text, str) or not text.strip():
        return None
    parts = _amount_and_rest(text)
    if not parts:
        return None
    amount, rest, chinese = parts
    if NOT_ONE_AMOUNT.search(rest):
        return None
    found = set()
    for pattern, code in MARKERS:
        for match in re.finditer(pattern, rest, re.I):
            found.add(code or ('CNY' if match.group().upper() == 'RMB' else match.group().upper()))
        rest = re.sub(pattern, ' ', rest, flags=re.I)
    if found == {'CNY', 'JPY'}:
        found = {'JPY'}  # "¥150,000 JPY": the symbol is shared, the code decides.
    if chinese and not found:
        # "3万8" or "一万五" in a Chinese request is an amount in yuan; a bare numeral such as the
        # 一 in "一半" (half) is not an amount at all.
        if not re.search('[' + ''.join(CN_SMALL) + ''.join(CN_BIG) + ']', text):
            return None
        found = {'CNY'}
    if len(found) != 1:
        return None
    return (found.pop(), amount) if amount > 0 else None

ONE_ETH = r'(?<![0-9.])1\s*(?:test\s+|测试\s*)?ETH\b'
EQUALS = r'\s*(?:=|＝|≈|\bis worth\b|\bequals\b|\bis\b|等于|折合|合)\s*'
AMOUNT_TEXT = (rf'(?:(?:{_ANY_MARKER})\s*)*(?:{_NUMBER})(?:\s*(?:{_SCALE})(?![A-Za-z]))?'
                rf'(?:\s*(?:{_ANY_MARKER}))*')
RATE_AFTER = re.compile(ONE_ETH + EQUALS + rf'(?P<amount>{AMOUNT_TEXT})', re.I)
RATE_BEFORE = re.compile(rf'(?P<amount>{AMOUNT_TEXT})' + EQUALS + ONE_ETH, re.I)


def stated_rates(sources):
    """Rates the parties wrote ("1 ETH = 1,000 USD"); a later message replaces an earlier one."""
    rates = {}
    for source in sources:
        found = [(m.start(), m['amount']) for m in RATE_AFTER.finditer(source)]
        found += [(m.start(), m['amount']) for m in RATE_BEFORE.finditer(source)]
        for _, amount in sorted(found):
            parsed = parse(amount.strip())
            if parsed:
                rates[parsed[0]] = parsed[1]
    return rates


def _fraction(value):
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return None
    return Fraction(number) if number.is_finite() and number > 0 else None


def _coingecko(get):
    data = get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&include_last_updated_at=true'
               '&vs_currencies=' + ','.join(code.lower() for code in CODES))['ethereum']
    stamp = data.get('last_updated_at')
    return {code: data[code.lower()] for code in CODES if code.lower() in data}, stamp


def _coinbase(get):
    rates = get('https://api.coinbase.com/v2/exchange-rates?currency=ETH')['data']['rates']
    return {code: rates[code] for code in CODES if code in rates}, None


PROVIDERS = [('CoinGecko', _coingecko), ('Coinbase', _coinbase)]


def _http_get(url):
    import httpx
    with httpx.Client(timeout=httpx.Timeout(4, connect=3), follow_redirects=False) as client:
        response = client.get(url, headers={'Accept': 'application/json'})
        response.raise_for_status()
        return response.json()


def _read_cache():
    try:
        data = json.loads(CACHE.read_text())
        prices = {code: _fraction(value) for code, value in data['prices'].items() if code in CODES}
        return {'prices': {k: v for k, v in prices.items() if v}, 'provider': data['provider'],
                'asOf': data['asOf'], 'fetched': float(data['fetched'])}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _write_cache(entry):
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        temporary = CACHE.with_suffix('.tmp')
        temporary.write_text(json.dumps({'prices': {k: str(Decimal(v.numerator) / Decimal(v.denominator))
                                                     for k, v in entry['prices'].items()},
                                         'provider': entry['provider'], 'asOf': entry['asOf'],
                                         'fetched': entry['fetched']}))
        temporary.replace(CACHE)
    except OSError:
        pass  # A cache is an optimisation; conversion still works without it.


def live_prices(get=_http_get, now=time.time):
    """{'prices', 'provider', 'asOf', 'stale'} from the cache or a live source, or None."""
    cached = _read_cache()
    if cached and now() - cached['fetched'] < CACHE_SECONDS:
        return dict(cached, stale=False)
    for name, provider in PROVIDERS:
        try:
            raw, stamp = provider(get)
        except Exception:
            continue
        prices = {code: _fraction(value) for code, value in raw.items()}
        prices = {code: value for code, value in prices.items() if value}
        if 'USD' not in prices:
            continue
        moment = datetime.fromtimestamp(stamp if isinstance(stamp, (int, float)) else now(), timezone.utc)
        entry = {'prices': prices, 'provider': name, 'asOf': moment.strftime('%Y-%m-%dT%H:%M:%SZ'),
                 'fetched': now()}
        _write_cache(entry)
        return dict(entry, stale=False)
    return dict(cached, stale=True) if cached else None


def reference_prices():
    table = dict(REFERENCE_PRICES)
    try:
        override = json.loads(os.getenv('ACCORD_ETH_PRICES') or '{}')
    except ValueError:
        override = {}
    if isinstance(override, dict):
        table.update({code.upper(): value for code, value in override.items()
                      if isinstance(code, str) and code.upper() in table})
    return {code: value for code, value in ((c, _fraction(v)) for c, v in table.items()) if value}


class RateBook:
    """The rates used for one Agent 1 turn; the result records them so the next turn reuses them."""

    def __init__(self, sources, locked=None, live=None):
        self.stated = stated_rates(sources)
        self.locked = {}
        for entry in locked or []:
            value = _fraction(entry.get('unitsPerEth')) if isinstance(entry, dict) else None
            if value and entry.get('currency') in CODES:
                self.locked[entry['currency']] = dict(entry)
        self.live = live if live is not None else os.getenv('ACCORD_RATES', 'live') != 'reference'
        self._prices = None
        self.used = {}

    def _market(self):
        if self._prices is None:
            self._prices = (live_prices() if self.live else None) or False
        return self._prices or None

    def price(self, currency):
        """(units per ETH, record) or (None, None)."""
        if currency in self.stated:
            value = self.stated[currency]
            record = {'currency': currency, 'unitsPerEth': number_text(value), 'source': 'stated',
                      'asOf': None, 'provider': None}
        elif currency in self.locked:
            record = self.locked[currency]
            value = _fraction(record['unitsPerEth'])
        else:
            market = self._market()
            if market and currency in market['prices']:
                value = market['prices'][currency]
                record = {'currency': currency, 'unitsPerEth': number_text(value),
                          'source': 'cached' if market['stale'] else 'live',
                          'asOf': market['asOf'], 'provider': market['provider']}
            else:
                value = reference_prices().get(currency)
                if not value:
                    return None, None
                record = {'currency': currency, 'unitsPerEth': number_text(value), 'source': 'reference',
                          'asOf': None, 'provider': None}
        self.used[currency] = record
        return value, record

    def records(self):
        """Rates used this turn, plus earlier ones that still apply to the draft."""
        merged = {code: entry for code, entry in self.locked.items()}
        merged.update(self.used)
        return [merged[code] for code in sorted(merged)]


ACTIVE = contextvars.ContextVar('accord_rate_book', default=None)


def to_wei(quote, sources):
    """Wei for a quote in another currency, rounded to 6 ETH decimals; None if not convertible."""
    parsed = parse(quote)
    return wei_for(parsed[0], parsed[1], sources) if parsed else None


def wei_for(code, amount, sources):
    """Wei for an amount in one currency at the turn's rate, rounded to 6 ETH decimals."""
    # Outside an Agent 1 turn (tests, helpers) only stated and reference rates are used.
    book = ACTIVE.get() or RateBook(sources, live=False)
    per_eth, _ = book.price(code)
    if not per_eth:
        return None
    value = Fraction(amount) * WEI / per_eth
    rounded = (value / STEP + Fraction(1, 2)).__floor__() * STEP
    return int(rounded) if rounded > 0 else None


def number_text(value):
    """'1670' for a whole number, otherwise the exact decimal ('1667.36')."""
    if value.denominator == 1:
        return str(value.numerator)
    text = format(Decimal(value.numerator) / Decimal(value.denominator), 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text
