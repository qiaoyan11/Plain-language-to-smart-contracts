"""Extract terms, reconcile exact payments, then validate the existing v1 handoff."""
import json
import re
from fractions import Fraction
from uuid import uuid4

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
            if re.search(r"[0-9][,.' \u00a0\u202f]+$", before):
                continue
            # A bare quote must not strip an explicit unit or currency from the source.
            if bare and (UNIT_BEFORE.search(before) or UNIT_AFTER.match(after)
                         or re.search(r'[$\u20ac\u00a3\u00a5\u20b9\u20bf]\s*$', before)
                         or re.search(r'\b[A-Z]{3,6}\s*$', before)
                         or re.match(r'\s*[A-Z]{3,6}\b', after)):
                continue
            return True
    return False


def value_of(quote, sources, old_amounts, total=None, unit=None):
    if not isinstance(quote, str):
        return None
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
                        amount = AMOUNT.match(text)
                        basis = total if TOTAL_BASIS.match(text) else value_of(amount[0], [source], set()) if amount else None
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


def title_key(title):
    return ' '.join(title.split()).casefold()


def draft_agreement(payload, extractor=extract):
    validate('ClarifyInput', payload)
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
    unsupported = list(unsupported)
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

    name = shorten(terms['name'])
    if not name:
        ask('name', 'What is the project called?')
    draft = dict(schemaVersion=1, projectId=old.get('projectId') or str(uuid4()),
                 specVersion=old.get('specVersion', 1), name=name or 'Untitled project',
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
        unsupported.append('The requested schedule exceeds the five-milestone limit.')
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
        if not amount:
            ask(f'milestones.{index}.amountWei', f'What exact amount is payable for milestone {index}?')
        if not row['title']:
            ask(f'milestones.{index}.title', f'What deliverable must be accepted for milestone {index}?')
        milestones.append(dict(id=index, title=shorten(row['title']) or f'Milestone {index}', amountWei=amount))
    if not rows:
        ask('milestones', 'What deliverables should the client accept, in payment order?')
    if milestones and all(m['amountWei'] for m in milestones):
        calculated = sum(int(m['amountWei']) for m in milestones)
        if calculated > MAX_UINT:
            raise ValueError('Milestone sum exceeds uint256.')
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
    result = validate('ClarifyResult', dict(status=status, draftSpec=draft, questions=questions,
                                            unsupportedTerms=unsupported))
    return result, notes


def clarify(payload, extractor=extract):
    result, notes = draft_agreement(payload, extractor)
    return validate('ClarifyResult', dict(result, separateTerms=notes))
