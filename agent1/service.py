"""Extract terms, reconcile exact payments, then validate the existing v1 handoff."""
import json
import re
from fractions import Fraction
from uuid import uuid4

from agent1.model import extract
from agent1.prompts import INSTRUCTIONS
from shared.handoff import MAX_UINT, validate

AMOUNT = re.compile(r'([0-9]+(?:\.[0-9]+)?)\s*(?:(?:test|Sepolia)\s+)?(ETH|wei|%)', re.I)


OPEN_ENDED = re.compile(
    r'(?:直至|直到|改至|改到|改得|修改至)\s*(?:甲方|客户|业主)(?:完全)?满意'
    r'|(?:无限次|不限次数)(?:免费)?修改'
    r'|\buntil (?:the (?:client|customer) is (?:fully )?)?satisfied\b'
    r'|\bunlimited (?:rounds of )?revisions\b', re.I)
REVISION_FIELD = 'acceptance.openEndedRevisions'


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
    if re.search(r'[\u3400-\u9fff]', clause):
        question = (f'“{clause}”可能让阶段款长期等待验收。双方用哪份设计稿或哪项测试判断交付达标？'
                    '若已有明确约定，请写出替代原条款的文字。')
    else:
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
    if quote not in old_amounts and not any(literal.search(s) for s in sources):
        return None
    value = Fraction(match[1])
    unit = match[2].lower()
    if unit == '%':
        if total is None or value > 100:
            return None
        value *= Fraction(int(total), 100)
    elif unit == 'eth':
        value *= 10**18
    if value.denominator == 1 and 0 < value <= MAX_UINT:
        return str(value.numerator)
    return None


def draft_agreement(payload, extractor=extract):
    validate('ClarifyInput', payload)
    old = payload['draftSpec'] or {}
    sources = [m['content'] for m in payload['history'] if m['role'] == 'user'] + [payload['message']]
    terms = extractor(INSTRUCTIONS, payload)
    questions = terms['questions']
    unsupported = terms['unsupportedTerms']
    if not isinstance(questions, list) or not isinstance(unsupported, list):
        raise ValueError('Expected lists of questions and unsupported terms.')
    def ask(field, question):
        if not any(q['field'] == field for q in questions):
            questions.append({'field': field, 'question': question})

    name = terms['name']
    if not name:
        ask('name', 'What is the project called?')
    draft = dict(schemaVersion=1, projectId=old.get('projectId') or str(uuid4()),
                 specVersion=old.get('specVersion', 1), name=name or 'Untitled project',
                 approvalRole='client', refundPolicy='none', deadline=None)
    for field, role in [('clientWallet', 'client'), ('developerWallet', 'provider')]:
        wallet = terms[field]
        known = wallet and (wallet == old.get(field) or any(wallet in s for s in sources))
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
    if not total:
        ask('totalAmountWei', 'What is the total escrow amount in ETH or wei?')
    # A follow-up about a wallet must not accidentally discard a refund condition.
    # The caller supplies the previous result in the assistant history (as chat does).
    previous = {}
    for turn in reversed(payload['history']):
        if turn['role'] == 'assistant':
            try:
                entry = json.loads(turn['content'])
            except ValueError:
                continue
            if isinstance(entry, dict):
                previous = entry.get('result', entry)
                if isinstance(previous, dict) and 'unsupportedTerms' in previous:
                    break
                previous = {}
    withdrawals = terms['withdrawals']
    for condition in previous.get('unsupportedTerms', []):
        removal = next((item['userQuote'] for item in withdrawals
                        if item['condition'] == condition), None)
        if not isinstance(removal, str) or not removal.strip() or removal not in payload['message']:
            if condition not in unsupported:
                unsupported.append(condition)
    review = revision_question(payload['message'], previous, terms)
    if review:
        questions = [review] + [q for q in questions if q['field'] not in (REVISION_FIELD, 'acceptance', 'revision.followup')]
    elif terms['revisionRiskOpen']:
        ask('acceptance', 'What would count as acceptance, how many rounds are included, and '
            'what happens to this payment if the client keeps requesting changes?')
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
    result, _ = draft_agreement(payload, extractor)
    return result
