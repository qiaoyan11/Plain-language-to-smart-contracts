"""Review period (v2): "deemed accepted if the client raises no objection within ten (10) days".

The model only quotes the words; this module turns them into seconds and a change-request count, so
a duration is never rounded or invented by the model. See docs/REVIEW_PERIOD_V2.md.
"""
import math
import re

from agent1.currency import chinese_number

MIN_SECONDS, MAX_SECONDS, MAX_CHANGES = 60, 90 * 86400, 20
WORDS = {'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7,
         'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14,
         'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
         'thirty': 30, 'forty': 40, 'forty-five': 45, 'sixty': 60, 'ninety': 90, 'single': 1}
# Unit words, longest first, with the seconds in one unit. Business days are handled separately.
UNITS = [
    (r'business days?|working days?|个工作日|工作日', 'business'),
    (r'calendar days?|days?|天|日', 86400),
    (r'weeks?|周|星期|个星期|礼拜', 7 * 86400),
    (r'fortnight', 14 * 86400),
    (r'months?|个月|月', 30 * 86400),
    (r'hours?|hrs?|小时|个小时', 3600),
    (r'minutes?|mins?|分钟', 60),
]
UNIT = re.compile('|'.join(f'(?:{pattern})' for pattern, _ in UNITS), re.I)
CN_NUMERAL = re.compile('[零〇一二两三四五六七八九十百]+')
# A message that talks about review, automatic release or changes may be turning the feature off.
REVIEW_WORDS = re.compile(r'review|respond|response|objection|deem|automatic|auto|silen|claim|accept|approv'
                          r'|revision|change request|验收|自动|回应|回复|异议|视为|默认|修改', re.I)
# Not-enforced notes that the review period now enforces: acceptance by silence, not dates or refunds.
DEEMED = re.compile(r"deem|(?:no|without|fails? to|does not|doesn't|do not)\s+(?:\w+\s+){0,2}(?:respon|object|repl|reject|request)"
                    r"|silence|auto(?:matic)?(?:ally)?[\s-]*(?:accept|approv)|视为|异议|未(?:提出|回复|回应)|默认(?:验收|通过)", re.I)


def _number(text):
    """The one count in text: digits win over words ("ten (10) days" is 10)."""
    digits = re.findall(r'\d+(?:\.\d+)?', text)
    if digits:
        return float(digits[-1]) if len(set(digits)) == 1 else None
    words = [w for w in re.findall(r'[a-z]+(?:-[a-z]+)?', text.lower()) if w in WORDS or w.split('-')[0] in WORDS]
    if words:
        tens = {'twenty': 20, 'thirty': 30, 'forty': 40, 'sixty': 60, 'ninety': 90}
        first = words[0]
        if '-' in first and first not in WORDS:  # "twenty-one"
            head, tail = first.split('-', 1)
            return float(tens.get(head, 0) + WORDS.get(tail, 0)) or None
        if len(words) > 1 and first in tens and WORDS.get(words[1], 10) < 10:
            return float(tens[first] + WORDS[words[1]])
        return float(WORDS[first])
    found = CN_NUMERAL.findall(text)
    if len(found) == 1:
        value = chinese_number(found[0])
        return float(value) if value else None
    return None


def parse_duration(quote):
    """Seconds in a quoted review window, or None when it is not one clear duration."""
    if not isinstance(quote, str):
        return None
    units = UNIT.findall(quote)
    if len(units) != 1:
        return None
    match = UNIT.search(quote)
    before = quote[:match.start()]
    count = _number(before) if before.strip() else (1 if re.match(r'(?i)fortnight', match.group()) else None)
    if count is None or count <= 0:
        return None
    unit = next(size for pattern, size in UNITS if re.fullmatch(pattern, match.group(), re.I))
    if unit == 'business':
        # N business days take at most N calendar days plus a weekend for every started week:
        # the client never gets less time than the contract gives.
        days = int(math.ceil(count))
        seconds = (days + 2 * math.ceil(days / 5)) * 86400
    else:
        seconds = int(count * unit)
    return seconds if MIN_SECONDS <= seconds <= MAX_SECONDS else None


def parse_limit(quote):
    """Change requests allowed per milestone: 0 for unlimited, None when unclear."""
    if not isinstance(quote, str) or not quote.strip():
        return None
    if re.search(r'(?i)unlimited|any number|不限|无限', quote):
        return 0
    count = _number(quote)
    if count is None or count != int(count) or not 1 <= count <= MAX_CHANGES:
        return None
    return int(count)


def review_terms(terms, message, sources, old):
    """(reviewPeriodSeconds, changeRequestLimit, note) for this turn.

    A quote must appear in what the user wrote. A model that leaves the period out on an unrelated
    turn ("make it 3 payments") does not remove it; a message about review or automatic payment can.
    The note names a deemed acceptance the program could not read, so it is not silently lost.
    """
    quote = terms.get('reviewPeriodQuote')
    quoted = isinstance(quote, str) and quote.strip() and any(quote in source for source in sources)
    keep_old = bool(old.get('reviewPeriodSeconds')) and not REVIEW_WORDS.search(message)
    if quoted:
        period = parse_duration(quote)
        if period is None:
            return None, None, f'automatic acceptance after {quote.strip()}'
    elif keep_old:
        period = old['reviewPeriodSeconds']
    else:
        return None, None, None
    limit_quote = terms.get('changeRequestLimitQuote')
    limit = None
    if isinstance(limit_quote, str) and limit_quote.strip() and any(limit_quote in s for s in sources):
        limit = parse_limit(limit_quote)
    if limit is None:
        limit = old.get('changeRequestLimit', 0) if keep_old or old.get('reviewPeriodSeconds') == period else 0
    return period, limit, None
