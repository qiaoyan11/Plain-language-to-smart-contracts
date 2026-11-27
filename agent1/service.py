"""Extract terms, reconcile exact payments, then validate the existing v1 handoff."""
import json
import re
from fractions import Fraction
from uuid import uuid4

from agent1 import currency
from agent1.model import extract
from agent1.prompts import INSTRUCTIONS
from shared.handoff import MAX_UINT, validate

AMOUNT = re.compile(r'([0-9]+(?:\.[0-9]+)?)\s*(?:(?:test|Sepolia|\u6d4b\u8bd5)\s*)?(ETH|wei|%|\uff05)', re.I)
NUMBER = re.compile(r'[0-9]+(?:\.[0-9]+)?')
PERCENT_OF = re.compile(r'([0-9]+(?:\.[0-9]+)?)\s*[%\uff05]\s+of\s+(.+)', re.I)
TOTAL_BASIS = re.compile(r'(?:the\s+)?(?:(?:agreed|contract)\s+)?total(?:\s+(?:amount|price|budget))?\b', re.I)
WALLET = re.compile(r'0x[0-9a-fA-F]{40}')
PAYMENT_TERMS = re.compile(
    r'\b(?:half|halves|thirds?|quarters?|percent(?:age)?|split|share|price|amount|budget|cost|fee|'
    r'pay|paid|payment|payable|deposit|refund|total|eth|wei)\b|[%\uff05$\u20ac\u00a3\u00a5]'
    r'|[\u4ed8\u6b3e\u4ef7\u989d\u534a]|\u767e\u5206|\u5206\u4e4b', re.I)


def mentions_payment(message):
    """Whether a message could change a payment value. Wallet addresses alone cannot."""
    text = WALLET.sub(' ', message)
    return bool(re.search(r'\d', text) or PAYMENT_TERMS.search(text))


OPEN_ENDED = re.compile(
    r'(?:\u76f4\u81f3|\u76f4\u5230|\u6539\u81f3|\u6539\u5230|\u6539\u5f97|\u4fee\u6539\u81f3)\s*'
    r'(?:\u7532\u65b9|\u5ba2\u6237|\u4e1a\u4e3b)(?:\u5b8c\u5168)?\u6ee1\u610f'
    r'|(?:\u65e0\u9650\u6b21|\u4e0d\u9650\u6b21\u6570)(?:\u514d\u8d39)?\u4fee\u6539'
    r'|\buntil (?:the (?:client|customer) is (?:fully )?)?satisfied\b'
    r'|\bunlimited (?:rounds of )?revisions\b', re.I)
REVISION_FIELD = 'acceptance.openEndedRevisions'


def canonical_field(field):
    if field == 'total':
        return 'totalAmountWei'
    return re.sub(r'^(milestones\.\d+)\.amount$', r'\1.amountWei', field)


def previous_result(history):
    """Read the result retained by the caller, including its unresolved questions."""
    for turn in reversed(history):
        if turn['role'] != 'assistant':
            continue
        try:
            entry = json.loads(turn['content'])
        except ValueError:
            continue
        if isinstance(entry, dict):
            result = entry.get('result', entry)
            if isinstance(result, dict) and 'unsupportedTerms' in result:
                if 'separateTerms' in entry and 'separateTerms' not in result:
                    result = dict(result, separateTerms=entry['separateTerms'])
                if 'result' in entry and 'question' in entry:
                    return dict(result, displayedQuestion=entry['question'])
                return result
    return {}


def resolved_question_fields(terms, message):
    resolutions = terms.get('resolvedQuestions', [])
    if not isinstance(resolutions, list):
        return set()
    # Entries without a field and an exact current quote are not evidence; ignore them.
    return {canonical_field(item['field']) for item in resolutions
            if isinstance(item, dict) and isinstance(item.get('field'), str) and item['field'].strip()
            and isinstance(item.get('userQuote'), str) and item['userQuote'].strip()
            and item['userQuote'] in message}


def revision_question(message, previous, terms):
    prior = next((q for q in previous.get('questions', []) if q['field'] == REVISION_FIELD), None)
    quote = terms.get('revisionResolutionQuote')
    resolved = (not terms['revisionRiskOpen'] and isinstance(quote, str)
                and bool(quote.strip()) and quote in message)
    if resolved:
        return None
    match = OPEN_ENDED.search(message)
    if not match:
        followup = next((q for q in terms['questions'] if q['field'] == 'revision.followup'), None)
        if prior and followup:
            return dict(field=REVISION_FIELD, question=followup['question'])
        return prior
    clause = match.group()
    question = (f'“{clause}” could leave the milestone payment waiting indefinitely. '
                'Which agreed mockup or test determines acceptance? '
                'If the parties already settled this, give their replacement wording.')
    return dict(field=REVISION_FIELD, question=question)


MONEY_UNITS = (r'usd[ct]?|eur|gbp|cny|rmb|jpy|cad|aud|inr|btc|wbtc|weth|gwei|dai|sol|'
               r'dollars?|euros?|pounds?|yuan|yen|rupees?|bitcoins?|satoshis?|ether|eth|wei')
UNIT_BEFORE = re.compile(r'\b(?:' + MONEY_UNITS + r')\s*$', re.I)
UNIT_AFTER = re.compile(r'\s*(?:[%\uff05]|(?:' + MONEY_UNITS
                        + r'|percent(?:age)?|per\s+cent|bps|basis\s+points?'
                          r'|hundred|thousand|million|billion|trillion)\b)', re.I)


def quote_in(quote, sources, bare=False):
    literal = re.compile(r'(?<![a-zA-Z0-9_.+-])' + re.escape(quote.strip()) + r'(?![a-zA-Z0-9]|\.\d)', re.I)
    for source in sources:
        for found in literal.finditer(source):
            before, after = source[:found.start()], source[found.end():]
            separator = re.search(r"[0-9]([,.' \u00a0\u202f]+)$", before)
            if separator:
                # "1, 500 ETH" or "1.5 ETH" continue one number. In "Stages 3 to 6, 24 ETH" a comma
                # and a space list the next number: a group after ", " always has three digits.
                digits = re.match(r'[0-9]+', quote.strip())
                listed = re.fullmatch(r',[ \u00a0\u202f]+', separator[1]) and digits and len(digits[0]) != 3
                if not listed:
                    continue
            # A bare quote must not strip an explicit unit or currency from the source.
            if bare and (UNIT_BEFORE.search(before) or UNIT_AFTER.match(after)
                         or re.search(r'[$\u20ac\u00a3\u00a5\u20b9\u20bf]\s*$', before)
                         or re.search(r'\b[A-Z]{3,6}\s*$', before)
                         or re.match(r'\s*[A-Z]{3,6}\b', after)):
                continue
            return True
    return False


def leading_amount(text):
    """The amount that starts text: "0.02 ETH", "$1,000" or "1,000 USD"."""
    amount = AMOUNT.match(text)
    if amount:
        return amount[0]
    fiat = re.match(currency.AMOUNT_TEXT, text, re.I)
    return fiat[0].strip() if fiat and currency.parse(fiat[0].strip()) else None


def value_of(quote, sources, old_amounts, total=None, unit=None):
    if not isinstance(quote, str):
        return None
    if not AMOUNT.fullmatch(quote.strip()) and currency.parse(quote):
        # "$8,000" or "89,800 元": converted to test ETH, so the user never has to.
        if quote not in old_amounts and not quote_in(quote, sources):
            return None
        wei = currency.to_wei(quote, sources)
        return str(wei) if wei and wei <= MAX_UINT else None
    match = AMOUNT.fullmatch(quote.strip())
    bare = NUMBER.fullmatch(quote.strip())
    expression = PERCENT_OF.fullmatch(quote.strip())
    if quote not in old_amounts and not quote_in(quote, sources, bool(bare)):
        # "25% of 0.02 ETH" may restate a percentage the user listed ("25%, 25% and 50% of
        # 0.02 ETH"); the expression's basis is still checked against the agreed total below.
        stated_percent = expression and any(quote_in(expression[1] + sign, sources) for sign in ('%', '\uff05'))
        # The model may add the known unit to an otherwise exact user quote.
        # Check the number without a unit in the source before accepting that formatting.
        if not stated_percent and not (match and unit in ('eth', 'wei') and match[2].lower() == unit
                                       and quote_in(match[1], sources, bare=True)):
            return None
    if expression:
        basis = total if TOTAL_BASIS.fullmatch(expression[2].strip()) else value_of(expression[2], sources, set())
        if total is None or basis is None or basis != total:
            return None
        value, unit = Fraction(expression[1]), '%'
    elif match:
        value, unit = Fraction(match[1]), match[2].lower().replace('\uff05', '%')
        if unit == '%':
            literal = re.compile(r'(?<![a-zA-Z0-9_.+-])' + re.escape(quote.strip()) + r'(?![a-zA-Z0-9])', re.I)
            for source in reversed(sources):
                occurrences = list(literal.finditer(source))
                if not occurrences:
                    continue
                for found in occurrences:
                    tail = source[found.end():]
                    of = re.match(r'\s+of\s+', tail, re.I)
                    if of:
                        text = tail[of.end():]
                        amount = leading_amount(text)
                        basis = total if TOTAL_BASIS.match(text) else value_of(amount, [source], set()) if amount else None
                        if basis is None or basis != total:
                            return None
                break
    elif bare and unit in ('eth', 'wei'):
        value = Fraction(quote.strip())
    else:
        return None
    if unit == '%':
        if total is None or value > 100:
            return None
        value *= Fraction(int(total), 100)
    elif unit == 'eth':
        value *= 10**18
    if value.denominator == 1 and 0 < value <= MAX_UINT:
        return str(value.numerator)
    return None


def question_unit(question):
    if not isinstance(question, dict):
        return None
    text = question.get('question', '')
    if re.search(r'[%\uff05]|\bpercent(?:age)?\b', text, re.I):
        return None
    units = {u.lower() for u in re.findall(r'\b(ETH|wei)\b', text, re.I)}
    return next(iter(units)) if len(units) == 1 else None


def repeats_stored_total(quote, stored, unit):
    """Compare a model's reformatting to a verified old value; never establish a new amount."""
    if not isinstance(quote, str) or stored is None:
        return False
    match = AMOUNT.fullmatch(quote.strip())
    if match:
        number, unit = match[1], match[2].lower()
    elif NUMBER.fullmatch(quote.strip()):
        number = quote.strip()
    else:
        return False
    return unit in ('eth', 'wei') and Fraction(number) * (10**18 if unit == 'eth' else 1) == int(stored)


def established_unit(payload, total, total_quote=None):
    """Require a source-denominated total, or an exact answer to a displayed unit question."""
    if total is None:
        return None
    sources = [m['content'] for m in payload['history'] if m['role'] == 'user'] + [payload['message']]
    direct = AMOUNT.fullmatch(total_quote.strip()) if isinstance(total_quote, str) else None
    if direct and direct[2].lower() in ('eth', 'wei') and value_of(total_quote, sources, set()) == total:
        return direct[2].lower()
    units, displayed = set(), None
    for turn in payload['history'] + [dict(role='user', content=payload['message'])]:
        if turn['role'] == 'assistant':
            try:
                entry = json.loads(turn['content'])
            except ValueError:
                continue
            displayed = entry.get('question') if isinstance(entry, dict) else None
            continue
        text = turn['content']
        for token in AMOUNT.finditer(text):
            unit = token[2].lower()
            if unit in ('eth', 'wei') and value_of(token[0], [text], set()) == total:
                units.add(unit)
        unit = question_unit(displayed)
        if (isinstance(displayed, dict) and canonical_field(displayed.get('field', '')) == 'totalAmountWei'
                and NUMBER.fullmatch(text.strip()) and value_of(text.strip(), [text], set(), unit=unit) == total):
            units.add(unit)
    return next(iter(units)) if len(units) == 1 else None


def missing_question(field, question):
    """Only remove our concrete missing-value prompts, never a model's new ambiguity question."""
    if field == 'totalAmountWei':
        return question in ('Please state the exact total in ETH or wei.', 'What is the total escrow amount in ETH or wei?')
    if field == 'milestones':
        return question == 'What deliverables should the client accept, in payment order?'
    match = re.fullmatch(r'milestones\.(\d+)\.amountWei', field)
    return bool(match and question == f'What exact amount is payable for milestone {match[1]}?')


def standard_missing_question(field, fallback):
    if field == 'totalAmountWei':
        return 'What is the total escrow amount in ETH or wei?'
    if field == 'milestones':
        return 'What deliverables should the client accept, in payment order?'
    match = re.fullmatch(r'milestones\.(\d+)\.amountWei', field)
    return f'What exact amount is payable for milestone {match[1]}?' if match else fallback


def wallet_in(wallet, sources):
    return isinstance(wallet, str) and any(
        re.search(r'(?<![a-zA-Z0-9_])' + re.escape(wallet) + r'(?![a-zA-Z0-9_])', s)
        for s in sources)


def repeats_payment(message, spec):
    """An entire message that only restates a verified price cannot revise other terms."""
    text = message.strip().rstrip('.').strip()
    total = spec.get('totalAmountWei')
    if not total:
        return False
    label = re.fullmatch(r'(?:(?:the )?(?:agreed )?total(?: (?:amount|price))?\s*(?:is|:|=)?\s+(.+)|'
                         r'(.+?)\s+(?:in total|total))', text, re.I)
    if label:
        quote = label[1] or label[2]
        return bool(AMOUNT.fullmatch(quote) and value_of(quote, [text], set()) == total)
    allocation = re.fullmatch(r'(.+?)\s+(?:(?:will be|is) (?:paid|payable)\s+)?for\s+'
                              r'(?:mil[e]?stone|stage|installment)\s+#?(\d+)', text, re.I)
    if not allocation:
        return False
    amount = value_of(allocation[1], [text], set(), total)
    return bool(amount and any(str(row['id']) == allocation[2] and row['amountWei'] == amount
                               for row in spec['milestones']))


def shorten(text, limit=120):
    """Keep the user's words but fit the 120-character name and title limit at a word boundary."""
    if not isinstance(text, str) or not text.strip():
        return None
    text = ' '.join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    space = cut.rfind(' ')
    return (cut[:space] if space > limit // 2 else cut).rstrip(' ,;:') + '\u2026'


def amount_token(text, sources=()):
    """A comparable form of one stated amount: wei for money, the number for a percentage."""
    match = AMOUNT.fullmatch(text.strip())
    if not match:
        wei = currency.to_wei(text, list(sources)) if converted(text) else None
        return ('wei', Fraction(wei)) if wei else None
    unit = match[2].lower().replace('\uff05', '%')
    if unit == '%':
        return ('%', Fraction(match[1]))
    return ('wei', Fraction(match[1]) * (10**18 if unit == 'eth' else 1))


# Everyday ways to state a share of the total. Each must appear in the user's own words.
FRACTION_WORDS = {
    'half': (1, 2), 'a half': (1, 2), 'one half': (1, 2), 'the other half': (1, 2), '1/2': (1, 2),
    'a third': (1, 3), 'one third': (1, 3), '1/3': (1, 3), 'two thirds': (2, 3), '2/3': (2, 3),
    'a quarter': (1, 4), 'one quarter': (1, 4), 'a fourth': (1, 4), '1/4': (1, 4),
    'three quarters': (3, 4), '3/4': (3, 4),
    '\u4e00\u534a': (1, 2), '\u534a\u6570': (1, 2), '\u53e6\u4e00\u534a': (1, 2), '\u4e09\u5206\u4e4b\u4e00': (1, 3),
    '\u4e09\u5206\u4e4b\u4e8c': (2, 3), '\u56db\u5206\u4e4b\u4e00': (1, 4), '\u56db\u5206\u4e4b\u4e09': (3, 4),
}
REST_WORDS = {'the rest', 'rest', 'the remaining', 'remaining', 'the remainder', 'remainder', 'the balance',
              'balance', 'the remaining balance', 'remaining balance', 'whatever is left',
              '\u5269\u4e0b\u7684', '\u5269\u4e0b', '\u5269\u4f59', '\u4f59\u6b3e', '\u5c3e\u6b3e', '\u4f59\u4e0b'}
EQUAL_WORDS = {'equal', 'equally', 'evenly', 'equal share', 'equal shares', 'equal parts', 'equal installments',
               'equal instalments', 'the same', 'same amount', 'the same amount', 'an equal amount', 'split evenly',
               '\u5e73\u5747', '\u5747\u5206', '\u5e73\u5206', '\u7b49\u989d'}
FIVE_LIMIT = 'The requested schedule exceeds the five-milestone limit.'


def natural_word(quote, sources):
    """The normalised quote when it is a share word the user actually wrote, else None."""
    if not isinstance(quote, str):
        return None
    word = ' '.join(quote.casefold().strip(' .,;:!\u3002\uff0c').split())
    if word not in FRACTION_WORDS and word not in REST_WORDS and word not in EQUAL_WORDS:
        return None
    return word if any(word in ' '.join(source.casefold().split()) for source in sources) else None


def round_step(value):
    return int((Fraction(value) / currency.STEP + Fraction(1, 2)).__floor__()) * currency.STEP


def fill_natural_amounts(rows, milestones, total, sources):
    """Resolve "half", "the rest" and "equal" rows from the agreed total; returns resolved ids."""
    if not total:
        return set()
    words = {m['id']: natural_word(row['amount'], sources) for row, m in zip(rows, milestones)
             if m['amountWei'] is None}
    resolved = set()
    for mid, word in words.items():
        if word in FRACTION_WORDS:
            top, bottom = FRACTION_WORDS[word]
            milestones[mid - 1]['amountWei'] = str(round_step(Fraction(int(total) * top, bottom)))
            resolved.add(mid)
    equal = [mid for mid, word in words.items() if word in EQUAL_WORDS]
    rest = [mid for mid, word in words.items() if word in REST_WORDS]
    known = sum(int(m['amountWei']) for m in milestones if m['amountWei'] and m['id'] not in equal + rest)
    open_rows = [m for m in milestones if m['amountWei'] is None and m['id'] not in equal + rest]
    left = int(total) - known
    if open_rows or left <= 0:
        return resolved
    if equal and not rest:
        share = (left // len(equal)) // currency.STEP * currency.STEP
        for mid in equal[:-1]:
            milestones[mid - 1]['amountWei'] = str(share)
        milestones[equal[-1] - 1]['amountWei'] = str(left - share * (len(equal) - 1))
        resolved.update(equal)
    elif len(rest) == 1 and not equal:
        milestones[rest[0] - 1]['amountWei'] = str(left)
        resolved.add(rest[0])
    return {mid for mid in resolved if int(milestones[mid - 1]['amountWei']) > 0}


def converted(quote):
    return isinstance(quote, str) and not AMOUNT.fullmatch(quote.strip()) and bool(currency.parse(quote))


def named_amounts(message):
    """Every amount the message states, as tokens, leaving out exchange rates such as 1 ETH = $1,000."""
    rates = [m.span() for pattern in (currency.RATE_AFTER, currency.RATE_BEFORE) for m in pattern.finditer(message)]
    inside = lambda span: any(start <= span[0] and span[1] <= end for start, end in rates)
    tokens = []
    for found in AMOUNT.finditer(message):
        if not inside(found.span()) and not re.match(r'\s*(?:=|\uff1d|equals\b|is worth\b)', message[found.end():], re.I):
            tokens.append(amount_token(found[0]))
    for found in re.finditer(currency.AMOUNT_TEXT, message, re.I):
        text = found[0].strip()
        if currency.parse(text) and not inside(found.span()):
            tokens.append(amount_token(text, [message]))
    return tokens


def complete_schedule(message, rows, milestones, row_units, total, disputed):
    """Amount fields settled by one message that states every milestone amount in ETH or wei.

    The total is settled too when the same message states it as the sum, or when the amounts
    add up to the agreed total. Percentages always add up to the total, so they settle only
    when the message also states that total. A message that also names another candidate
    amount, or whose amounts the model disputes this turn, settles nothing.
    """
    if not rows or not all(m['amountWei'] for m in milestones):
        return set()
    sources = [message]
    absolute = True
    allowed = set()
    for row, milestone, unit in zip(rows, milestones, row_units):
        quote = row['amount'].strip() if isinstance(row['amount'], str) else None
        if quote is None or value_of(quote, sources, set(), total, unit) != milestone['amountWei']:
            return set()
        match = AMOUNT.fullmatch(quote)
        if not ((match and match[2].lower() in ('eth', 'wei')) or (NUMBER.fullmatch(quote) and unit in ('eth', 'wei'))
                or converted(quote)):
            absolute = False
        allowed.add(amount_token(quote, sources) or ('wei', Fraction(int(milestone['amountWei']))))
        allowed.add(('wei', Fraction(int(milestone['amountWei']))))
    calculated = str(sum(int(m['amountWei']) for m in milestones))
    # A total written in another currency may differ from the sum by the 6-decimal rounding.
    slack = currency.STEP * len(milestones)
    close = lambda token: token and token[0] == 'wei' and abs(token[1] - int(calculated)) <= slack
    allowed.add(('wei', Fraction(int(calculated))))
    # "1 ETH = 1,000 USD" is an exchange rate, not a candidate amount.
    named = named_amounts(message)
    if any(token not in allowed and not close(token) for token in named):
        return set()
    stated = {str(calculated) if close(token) else None for token in named}
    fields = {f'milestones.{m["id"]}.amountWei' for m in milestones}
    if (fields | {'totalAmountWei'}) & disputed:
        return set()
    if calculated in stated:
        return fields | {'totalAmountWei'}
    if absolute and total == calculated:
        return fields | {'totalAmountWei'}
    return fields if absolute else set()


def term_key(term):
    return ' '.join(re.findall(r'\w+', term.casefold()))


def same_term(a, b):
    """The model rewords a condition slightly between turns; treat close rewordings as one."""
    if term_key(a) == term_key(b):
        return True
    x, y = set(term_key(a).split()), set(term_key(b).split())
    return bool(x and y) and len(x & y) / len(x | y) >= 0.7


def withdrawn_terms(history, previous):
    """Conditions flagged on an earlier turn and no longer open on the latest one."""
    earlier = []
    for turn in history:
        if turn['role'] != 'assistant':
            continue
        try:
            entry = json.loads(turn['content'])
        except ValueError:
            continue
        result = entry.get('result', entry) if isinstance(entry, dict) else None
        if isinstance(result, dict) and isinstance(result.get('unsupportedTerms'), list):
            earlier += [t for t in result['unsupportedTerms'] if isinstance(t, str)]
    still_open = previous.get('unsupportedTerms', [])
    return [t for t in earlier if not any(same_term(t, o) for o in still_open)]


def title_key(title):
    return ' '.join(title.split()).casefold()


def draft_agreement(payload, extractor=extract):
    validate('ClarifyInput', payload)
    previous = previous_result(payload['history'])
    sources = [m['content'] for m in payload['history'] if m['role'] == 'user'] + [payload['message']]
    # One rate per currency for the whole turn, reused on later turns so amounts do not drift.
    book = currency.RateBook(sources, previous.get('exchangeRates'))
    token = currency.ACTIVE.set(book)
    try:
        result, notes = reconcile(payload, extractor)
    finally:
        currency.ACTIVE.reset(token)
    rates = book.records()
    if rates:
        result['exchangeRates'] = rates
    return validate('ClarifyResult', result), notes


def reconcile(payload, extractor):
    old = payload['draftSpec'] or {}
    previous = previous_result(payload['history'])
    # Only reuse an already reconciled schedule. A changed price, an extra sentence,
    # an open business question or an incomplete allocation still needs interpretation.
    if (old and previous.get('draftSpec') == old and not previous['unsupportedTerms']
            and all(q['field'] in ('clientWallet', 'developerWallet') for q in previous['questions'])
            and old['milestones'] and all(row['amountWei'] for row in old['milestones'])
            and sum(int(row['amountWei']) for row in old['milestones']) == int(old['totalAmountWei'] or 0)
            and repeats_payment(payload['message'], old)):
        result = {key: previous[key] for key in ('status', 'draftSpec', 'questions', 'unsupportedTerms')}
        if previous.get('notEnforced'):
            result['notEnforced'] = previous['notEnforced']
        return validate('ClarifyResult', result), previous.get('separateTerms', [])
    sources = [m['content'] for m in payload['history'] if m['role'] == 'user'] + [payload['message']]
    terms = extractor(INSTRUCTIONS, payload)
    questions = terms['questions']
    unsupported = terms['unsupportedTerms']
    if not isinstance(questions, list) or not isinstance(unsupported, list):
        raise ValueError('Expected lists of questions and unsupported terms.')
    missing_fields = {canonical_field(q['field']) for q in questions if q.get('kind') == 'missing'}
    protected_fields = {canonical_field(q['field']) for q in questions if q.get('kind') in ('conflict', 'semantic')}
    # A message without any payment terms (for example, only wallet addresses) cannot change or
    # dispute an amount, whatever the model reports for this turn.
    payment_message = mentions_payment(payload['message'])
    if not payment_message:
        protected_fields = {f for f in protected_fields
                            if f != 'totalAmountWei' and not re.fullmatch(r'milestones\.\d+\.amountWei', f)}
    questions = [dict(field=canonical_field(q['field']),
                      question=standard_missing_question(canonical_field(q['field']), q['question'])
                      if q.get('kind') == 'missing' else q['question']) for q in questions]
    changes = terms.get('changedFields')
    changed_fields = None
    # Malformed change metadata disables retention (changed_fields stays None); it never fails the turn.
    if (isinstance(changes, list) and all(isinstance(item, dict) and isinstance(item.get('field'), str)
            and isinstance(item.get('userQuote'), str) for item in changes)
            and all(item['userQuote'].strip() and item['userQuote'] in payload['message'] for item in changes)):
        changed_fields = {canonical_field(item['field']) for item in changes}
    # The model re-reads the original agreement every turn. A condition the user already moved
    # out of the contract stays out unless the current message raises it again.
    withdrawn = withdrawn_terms(payload['history'], previous)
    said = set(term_key(payload['message']).split())
    def raised_again(term):
        words = set(term_key(term).split())
        return bool(words) and len(words & said) / len(words) >= 0.5
    unsupported = [t for t in unsupported if raised_again(t) or not any(same_term(t, w) for w in withdrawn)]
    previous['questions'] = [dict(q, field=canonical_field(q['field'])) for q in previous.get('questions', [])]
    prior_questions = previous['questions']
    displayed = previous.get('displayedQuestion', prior_questions[0] if prior_questions else None)
    focus = canonical_field(displayed.get('field', '')) if isinstance(displayed, dict) and not previous.get('unsupportedTerms') else None
    answer = payload['message'].strip().rstrip('\u3002.').strip()
    answer_unit = question_unit(displayed)
    resolved = resolved_question_fields(terms, payload['message'])
    pending = [q for q in previous.get('questions', [])
               if q['field'] != REVISION_FIELD and q['field'] not in resolved]
    def ask(field, question):
        existing = next((q for q in questions if q['field'] == field), None)
        if existing:
            return
        questions.append({'field': field, 'question': question})

    # A missing title is not worth a question: the user can rename the agreement on review.
    name = shorten(terms['name']) or old.get('name') or 'Service agreement'
    draft = dict(schemaVersion=1, projectId=old.get('projectId') or str(uuid4()),
                 specVersion=old.get('specVersion', 1), name=name,
                 approvalRole='client', refundPolicy='none', deadline=None)
    for field, role in [('clientWallet', 'client'), ('developerWallet', 'provider')]:
        wallet = terms[field]
        known = isinstance(wallet, str) and (wallet == old.get(field) or wallet_in(wallet, sources))
        if not known or not re.fullmatch(r'0x[0-9a-fA-F]{40}', wallet) or int(wallet, 16) == 0:
            wallet = None
            ask(field, f'What is the {role} wallet address?')
        draft[field] = wallet
    if draft['clientWallet'] and draft['clientWallet'].lower() == (draft['developerWallet'] or '').lower():
        draft['developerWallet'] = None
        ask('developerWallet', 'Which distinct wallet belongs to the provider?')

    old_amounts = {f"{n} wei" for n in [old.get('totalAmountWei')] +
                   [m['amountWei'] for m in old.get('milestones', [])] if n}
    total_unit = established_unit(payload, old.get('totalAmountWei'))
    if focus == 'totalAmountWei' and NUMBER.fullmatch(answer):
        total_unit = answer_unit
    total_quote = answer if focus == 'totalAmountWei' and NUMBER.fullmatch(answer) and answer_unit else terms['total']
    total = value_of(total_quote, sources, old_amounts, unit=total_unit)
    if not payment_message and old.get('totalAmountWei'):
        total = old['totalAmountWei']
    if total is None and repeats_stored_total(total_quote, old.get('totalAmountWei'), total_unit):
        total = old['totalAmountWei']
    if total_quote is None and old.get('totalAmountWei'):
        total = old['totalAmountWei']
    if total_quote is not None and total is None:
        ask('totalAmountWei', 'Please state the exact total in ETH or wei.')
    unit = established_unit(payload, total, total_quote)
    rows = terms['milestones']
    if not isinstance(rows, list):
        raise ValueError('Expected a list of milestones.')
    rows = [dict(row) for row in rows]
    if len(rows) > 5:
        unsupported.append(FIVE_LIMIT)
        rows = []
    milestones = []
    row_units = []
    old_rows = {m['id']: m for m in old.get('milestones', [])}
    titles = [title_key(shorten(row['title']) or '') for row in rows]
    same_schedule = (titles == [title_key(m['title']) for m in old.get('milestones', [])]
                     and len(titles) == len(set(titles)))
    for index, row in enumerate(rows, 1):
        row_unit = unit
        if focus == f'milestones.{index}.amountWei' and NUMBER.fullmatch(answer):
            row_unit = answer_unit
            if row_unit:
                row['amount'] = answer
        row_units.append(row_unit)
        amount = value_of(row['amount'], sources, old_amounts, total, row_unit)
        field = f'milestones.{index}.amountWei'
        stored = old_rows.get(index, {}).get('amountWei')
        if stored and same_schedule and not payment_message:
            # The verified amount stands: this message has no payment terms to change it.
            amount = stored
        elif (amount is None and stored and same_schedule and changed_fields is not None
                and field not in changed_fields and field not in protected_fields
                and (row['amount'] is None or repeats_stored_total(row['amount'], stored, row_unit))):
            # The old accepted value remains the evidence. A renamed/reordered stage or any
            # current price change/conflict cannot use this retention path.
            amount = stored
        if not row['title']:
            ask(f'milestones.{index}.title', f'What deliverable must be accepted for milestone {index}?')
        milestones.append(dict(id=index, title=shorten(row['title']) or f'Milestone {index}', amountWei=amount))
    # "Half now and the rest on delivery": shares of the agreed total need no exact figure from the user.
    natural = fill_natural_amounts(rows, milestones, total, sources)
    for milestone in milestones:
        if not milestone['amountWei']:
            ask(f'milestones.{milestone["id"]}.amountWei', f'What exact amount is payable for milestone {milestone["id"]}?')
    if not rows:
        ask('milestones', 'What deliverables should the client accept, in payment order?')
    if milestones and all(m['amountWei'] for m in milestones):
        calculated = sum(int(m['amountWei']) for m in milestones)
        if calculated > MAX_UINT:
            raise ValueError('Milestone sum exceeds uint256.')
        rounded = natural or converted(total_quote) or any(converted(row['amount']) for row in rows)
        if total and rounded and abs(int(total) - calculated) <= currency.STEP * len(milestones):
            # Converted or shared amounts are rounded to 6 decimals; the contract holds their exact sum.
            total = str(calculated)
        if total and int(total) != calculated:
            ask('totalAmountWei', 'The milestone amounts and stated total differ. Which should change?')
            total = None
        elif total_quote is None:
            total = str(calculated)
    # Only a single, direct answer to the previous primary question may bypass missing model
    # resolution metadata. A candidate mentioned in a longer message is not a resolution.
    deterministic = set()
    current_sources = [payload['message']]
    def direct_answer(field, quote):
        return focus == field and isinstance(quote, str) and answer == quote.strip()
    conflicts = {canonical_field(q['field']) for q in terms['questions'] if q.get('kind') == 'conflict'}
    named = {w.lower() for w in WALLET.findall(payload['message'])}
    only_draft_wallets = bool(named) and named <= {(draft[f] or '').lower() for f in ('clientWallet', 'developerWallet')}
    for field in ('clientWallet', 'developerWallet'):
        # A new wallet written verbatim answers its question when the message names no other
        # address (no competing candidate) and the model reports no conflict.
        if (old.get(field) is None and draft[field] and wallet_in(draft[field], current_sources)
                and (direct_answer(field, draft[field]) or (only_draft_wallets and field not in conflicts))):
            deterministic.add(field)
    if (old.get('totalAmountWei') is None and total and direct_answer('totalAmountWei', total_quote)
            and value_of(total_quote, current_sources, set(), unit=answer_unit) == total):
        deterministic.add('totalAmountWei')
    for index, (row, milestone) in enumerate(zip(rows, milestones), 1):
        if (old_rows.get(index, {}).get('amountWei') is None and milestone['amountWei']
                and direct_answer(f'milestones.{index}.amountWei', row['amount'])
                and value_of(row['amount'], current_sources, set(), total, row_units[index - 1]) == milestone['amountWei']):
            deterministic.add(f'milestones.{index}.amountWei')
    disputed = {canonical_field(q['field']) for q in terms['questions'] if q.get('kind') != 'missing'}
    restated = complete_schedule(payload['message'], rows, milestones, row_units, total, disputed)
    if restated:
        # The newest message states the whole schedule itself, so it answers every open amount
        # question, including a total the model could only quote in another currency.
        deterministic |= restated
        if 'totalAmountWei' in restated:
            total = str(sum(int(m['amountWei']) for m in milestones))
    if old.get('milestones') and len(rows) != len(old['milestones']):
        # Numbered questions about the previous schedule no longer point at the same stage.
        # Missing amounts are asked again below; the model re-raises any doubt that still applies.
        pending = [q for q in pending if not re.match(r'milestones\.\d+\.', q['field'])]
    questions = [q for q in questions if q['field'] not in deterministic]
    pending = [q for q in pending if q['field'] not in deterministic]
    for question in pending:
        if question['field'] in missing_fields and not missing_question(question['field'], question['question']):
            # Reclassifying an unanswered conflict as missing must not erase its evidence or
            # turn it into an automatically removable missing-value prompt on the next turn.
            questions = [q for q in questions if q['field'] != question['field']]
        ask(question['field'], question['question'])
    supported_values = {f'milestones.{m["id"]}.amountWei' for m in milestones if m['amountWei']}
    if total:
        supported_values.add('totalAmountWei')
    if rows and all(row['title'] and any(title_key(row['title']) in title_key(source) for source in sources) for row in rows):
        supported_values.add('milestones')
    previous_missing = {q['field'] for q in prior_questions if missing_question(q['field'], q['question'])}
    previous_protected = {q['field'] for q in prior_questions if not missing_question(q['field'], q['question'])}
    previous_protected -= resolved | deterministic
    questions = [q for q in questions if not (q['field'] in supported_values and q['field'] not in protected_fields | previous_protected
        and (q['field'] in missing_fields or (q['field'] in previous_missing | resolved
                                             and missing_question(q['field'], q['question']))))]
    deterministic |= {f'milestones.{mid}.amountWei' for mid in natural}
    questions = [q for q in questions if q['field'] not in deterministic]
    if not payment_message:
        # New amount doubts raised on a message without payment terms are not evidence;
        # questions still open from earlier turns remain.
        open_fields = {q['field'] for q in pending}
        questions = [q for q in questions if q['field'] in open_fields or q['field'] not in supported_values
                     or not (q['field'] == 'totalAmountWei' or re.fullmatch(r'milestones\.\d+\.amountWei', q['field']))]
    if any(q['field'] == 'totalAmountWei' for q in questions):
        total = None
    if not total:
        ask('totalAmountWei', 'What is the total escrow amount in ETH or wei?')
    # A follow-up about a wallet must not accidentally discard a refund condition.
    # The caller supplies the previous result in the assistant history (as chat does).
    withdrawals = terms['withdrawals']
    for condition in previous.get('unsupportedTerms', []):
        removal = next((item['userQuote'] for item in withdrawals
                        if item['condition'] == condition), None)
        if not isinstance(removal, str) or not removal.strip() or removal not in payload['message']:
            if condition not in unsupported:
                unsupported.append(condition)
    # Conditions the contract cannot enforce do not stop the user: they stay in the written
    # agreement and the review page lists them. Only a schedule the contract cannot hold at all
    # (too many payments, or money to anyone but one provider) still needs an answer.
    blocking = [t for t in (terms.get('blockingTerms') or []) if isinstance(t, str)]
    still_blocking = [t for t in unsupported if t == FIVE_LIMIT or any(same_term(t, b) for b in blocking)]
    removed = {item.get('condition') for item in withdrawals if isinstance(item, dict)
               and isinstance(item.get('userQuote'), str) and item['userQuote'].strip()
               and item['userQuote'] in payload['message']}
    not_enforced = [t for t in previous.get('notEnforced', []) if isinstance(t, str) and t not in removed]
    for term in unsupported:
        if term not in still_blocking and not any(same_term(term, kept) for kept in not_enforced):
            not_enforced.append(term)
    unsupported = still_blocking
    review = revision_question(payload['message'], previous, terms)
    if review:
        pending_fields = {q['field'] for q in pending}
        questions = [review] + [q for q in questions
                               if q['field'] in pending_fields or q['field'] not in
                               (REVISION_FIELD, 'acceptance', 'revision.followup')]
    elif terms['revisionRiskOpen']:
        ask('acceptance', 'Which specific agreed criterion determines acceptance of this milestone?')
    draft.update(milestones=milestones, totalAmountWei=total)
    if old and draft != old:
        draft['specVersion'] += 1
    status = 'unsupported' if unsupported else ('needsClarification' if questions else 'readyForConfirmation')
    notes = terms['separateTerms'] if isinstance(terms['separateTerms'], list) else []
    # Only exact quotes of the parties are kept; paraphrases are not evidence and are dropped.
    notes = [note for note in notes if isinstance(note, str) and note.strip() and any(note in s for s in sources)]
    result = dict(status=status, draftSpec=draft, questions=questions, unsupportedTerms=unsupported)
    if not_enforced:
        result['notEnforced'] = not_enforced
    return validate('ClarifyResult', result), notes


def clarify(payload, extractor=extract):
    result, notes = draft_agreement(payload, extractor)
    return validate('ClarifyResult', dict(result, separateTerms=notes))
