"""Extract terms, reconcile exact payments, then validate the existing v1 handoff."""
import json
import re
from fractions import Fraction
from uuid import uuid4

from agent1.model import extract
from agent1.prompts import INSTRUCTIONS
from shared.handoff import MAX_UINT, validate

AMOUNT = re.compile(r'([0-9]+(?:\.[0-9]+)?)\s*(?:(?:test|Sepolia|\u6d4b\u8bd5)\s*)?(ETH|wei|%|\uff05)', re.I)


OPEN_ENDED = re.compile(
    r'(?:\u76f4\u81f3|\u76f4\u5230|\u6539\u81f3|\u6539\u5230|\u6539\u5f97|\u4fee\u6539\u81f3)\s*'
    r'(?:\u7532\u65b9|\u5ba2\u6237|\u4e1a\u4e3b)(?:\u5b8c\u5168)?\u6ee1\u610f'
    r'|(?:\u65e0\u9650\u6b21|\u4e0d\u9650\u6b21\u6570)(?:\u514d\u8d39)?\u4fee\u6539'
    r'|\buntil (?:the (?:client|customer) is (?:fully )?)?satisfied\b'
    r'|\bunlimited (?:rounds of )?revisions\b', re.I)
REVISION_FIELD = 'acceptance.openEndedRevisions'


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
                if 'result' in entry and 'question' in entry:
                    return dict(result, displayedQuestion=entry['question'])
                return result
    return {}


def resolved_question_fields(terms, message):
    resolutions = terms.get('resolvedQuestions', [])
    if not isinstance(resolutions, list) or not all(
            isinstance(item, dict) and isinstance(item.get('field'), str)
            and item['field'].strip() and isinstance(item.get('userQuote'), str)
            for item in resolutions):
        raise ValueError('Question resolutions require a field and a current user quote.')
    return {item['field'] for item in resolutions
            if item['userQuote'].strip() and item['userQuote'] in message}


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


def value_of(quote, sources, old_amounts, total=None):
    if not isinstance(quote, str):
        return None
    match = AMOUNT.fullmatch(quote.strip())
    if not match:
        return None
    literal = re.compile(r'(?<![a-zA-Z0-9_.+-])' + re.escape(quote.strip()) + r'(?![a-zA-Z0-9])', re.I)
    # Do not accept the tail of a grouped amount, e.g. "500 ETH" in "1,500 ETH".
    # A separator after a nonnumeric word still allows an ordinary amount quote.
    evidenced = any(not re.search(r"[0-9][,.' \u00a0\u202f]+$", source[:found.start()])
                    for source in sources for found in literal.finditer(source))
    if quote not in old_amounts and not evidenced:
        return None
    value = Fraction(match[1])
    unit = match[2].lower().replace('\uff05', '%')
    if unit == '%':
        if total is None or value > 100:
            return None
        value *= Fraction(int(total), 100)
    elif unit == 'eth':
        value *= 10**18
    if value.denominator == 1 and 0 < value <= MAX_UINT:
        return str(value.numerator)
    return None


def wallet_in(wallet, sources):
    return isinstance(wallet, str) and any(
        re.search(r'(?<![a-zA-Z0-9_])' + re.escape(wallet) + r'(?![a-zA-Z0-9_])', s)
        for s in sources)


def draft_agreement(payload, extractor=extract):
    validate('ClarifyInput', payload)
    old = payload['draftSpec'] or {}
    sources = [m['content'] for m in payload['history'] if m['role'] == 'user'] + [payload['message']]
    terms = extractor(INSTRUCTIONS, payload)
    questions = terms['questions']
    unsupported = terms['unsupportedTerms']
    if not isinstance(questions, list) or not isinstance(unsupported, list):
        raise ValueError('Expected lists of questions and unsupported terms.')
    questions, unsupported = [dict(q) for q in questions], list(unsupported)
    previous = previous_result(payload['history'])
    resolved = resolved_question_fields(terms, payload['message'])
    pending = [q for q in previous.get('questions', [])
               if q['field'] != REVISION_FIELD and q['field'] not in resolved]
    def ask(field, question):
        existing = next((q for q in questions if q['field'] == field), None)
        if existing:
            return
        questions.append({'field': field, 'question': question})

    name = terms['name']
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
    total = value_of(terms['total'], sources, old_amounts)
    if terms['total'] is None and old.get('totalAmountWei'):
        total = old['totalAmountWei']
    if terms['total'] is not None and total is None:
        ask('totalAmountWei', 'Please state the exact total in ETH or wei.')
    rows = terms['milestones']
    if not isinstance(rows, list):
        raise ValueError('Expected a list of milestones.')
    if len(rows) > 5:
        unsupported.append('The requested schedule exceeds the five-milestone limit.')
        rows = []
    milestones = []
    for index, row in enumerate(rows, 1):
        amount = value_of(row['amount'], sources, old_amounts, total)
        if not amount:
            ask(f'milestones.{index}.amountWei', f'What exact amount is payable for milestone {index}?')
        if not row['title']:
            ask(f'milestones.{index}.title', f'What deliverable must be accepted for milestone {index}?')
        milestones.append(dict(id=index, title=row['title'] or f'Milestone {index}', amountWei=amount))
    if not rows:
        ask('milestones', 'What deliverables should the client accept, in payment order?')
    if milestones and all(m['amountWei'] for m in milestones):
        calculated = sum(int(m['amountWei']) for m in milestones)
        if calculated > MAX_UINT:
            raise ValueError('Milestone sum exceeds uint256.')
        if total and int(total) != calculated:
            ask('totalAmountWei', 'The milestone amounts and stated total differ. Which should change?')
            total = None
        elif terms['total'] is None:
            total = str(calculated)
    # Only a single, direct answer to the previous primary question may bypass missing model
    # resolution metadata. A candidate mentioned in a longer message is not a resolution.
    deterministic = set()
    current_sources = [payload['message']]
    prior_questions = previous.get('questions', [])
    displayed = previous.get('displayedQuestion', prior_questions[0] if prior_questions else None)
    focus = displayed.get('field') if isinstance(displayed, dict) and not previous.get('unsupportedTerms') else None
    answer = payload['message'].strip().rstrip('\u3002.').strip()
    def direct_answer(field, quote):
        return focus == field and isinstance(quote, str) and answer == quote.strip()
    for field in ('clientWallet', 'developerWallet'):
        if (old.get(field) is None and draft[field] and direct_answer(field, draft[field])
                and wallet_in(draft[field], current_sources)):
            deterministic.add(field)
    if (old.get('totalAmountWei') is None and total and direct_answer('totalAmountWei', terms['total'])
            and value_of(terms['total'], current_sources, set()) == total):
        deterministic.add('totalAmountWei')
    old_rows = {m['id']: m for m in old.get('milestones', [])}
    for index, (row, milestone) in enumerate(zip(rows, milestones), 1):
        if (old_rows.get(index, {}).get('amountWei') is None and milestone['amountWei']
                and direct_answer(f'milestones.{index}.amountWei', row['amount'])
                and value_of(row['amount'], current_sources, set(), total) == milestone['amountWei']):
            deterministic.add(f'milestones.{index}.amountWei')
    questions = [q for q in questions if q['field'] not in deterministic]
    pending = [q for q in pending if q['field'] not in deterministic]
    for question in pending:
        ask(question['field'], question['question'])
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
    notes = terms['separateTerms']
    if not isinstance(notes, list) or not all(
            isinstance(note, str) and note.strip() and any(note in s for s in sources) for note in notes):
        raise ValueError('Separate terms must quote the parties.')
    result = validate('ClarifyResult', dict(status=status, draftSpec=draft, questions=questions,
                                            unsupportedTerms=unsupported))
    return result, notes


def clarify(payload, extractor=extract):
    result, notes = draft_agreement(payload, extractor)
    return validate('ClarifyResult', dict(result, separateTerms=notes))
