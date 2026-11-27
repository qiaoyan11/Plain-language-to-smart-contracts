"""Pure decision rules: a parsed request plus the project state give a PlanResult."""
import re
from decimal import Context, Decimal

# A deposit funds the whole escrow, so a deposit request that also names the milestone it covers
# ("put the rent for Dec 21-25 into escrow") is still a deposit. Words about paying the provider
# mean the model may have misread "pay milestone 1" on an unfunded escrow, so those still ask.
DEPOSIT_WORDS = re.compile(r'\b(?:deposit|fund|funds|funding|top\s*up|put|lock|escrow)\b|\u5b58\u5165|\u5145\u503c|\u6258\u7ba1', re.I)
PAY_WORDS = re.compile(r'\b(?:pay|pays|paid|paying|release|approve|approved|accept|accepted)\b|\u652f\u4ed8|\u4ed8\u6b3e|\u653e\u6b3e|\u9a8c\u6536', re.I)

TEXT = {
    'en': {
        'done': 'No transaction has been sent.',
        'mismatch': 'The project record does not match the deployed contract address. {done}',
        'unsupported': 'This request is not supported. You can ask about the escrow, deposit funds, or accept a milestone. {done}',
        'unsupported_held': 'This contract cannot refund, cancel, change an amount or pay anyone other than the provider '
                            'wallet. The escrow keeps its {balance} test ETH until the client approves the next milestone; '
                            'settle anything else under your written agreement. {done}',
        'unclear_summary': 'The request is not clear enough to act on. {done}',
        'unclear_question': 'What do you want to do: check the escrow, deposit funds, or accept a milestone?',
        'query': 'Escrow balance: {balance} test ETH. Funded: {funded}. Milestones: {items}. {done}',
        'query_item': '#{id} {title}, {eth} test ETH, {state}',
        'yes': 'yes', 'no': 'no', 'paid': 'paid', 'unpaid': 'unpaid',
        'deposit': 'Deposit {total} test ETH into the escrow. {done}',
        'deposit_named': 'Deposit {total} test ETH into the escrow. One deposit funds every milestone; '
                         'milestone #{id} is paid to the provider only after you accept it. {done}',
        'deposit_or_pay': 'The escrow is not funded yet, so no milestone can be paid. Do you want to deposit '
                          '{total} test ETH first? Ask to deposit, or use the deposit button.',
        'already_funded': 'The escrow is already funded, so it cannot be deposited again. {done}',
        'all_paid': 'All milestones are already paid. {done}',
        'ask_id_summary': 'The milestone to accept is not specified. {done}',
        'ask_id': 'Which milestone do you want to accept? The next unpaid milestone is #{id} "{title}".',
        'unknown_id': 'Milestone #{id} does not exist in this project. {done}',
        'unfunded': 'The escrow is not funded yet, so no milestone can be accepted. {done}',
        'is_paid': 'Milestone #{id} is already paid. {done}',
        'out_of_order': 'Milestones must be accepted in order. The next unpaid milestone is #{next_id}. {done}',
        'accept': 'Accept milestone #{id} "{title}" and pay {eth} test ETH to the provider wallet {wallet}. {done}',
        'model_error': 'The request could not be understood because of a service error. Please try again. {done}',
        'too_long': 'The message is too long. Please shorten it and try again. {done}',
        'bad_ids': 'The project data is not in the expected form, so the request cannot be handled. {done}',
    },
}


def _t(language, key, **kw):
    # Language remains an accepted argument for existing callers; UI copy is always English.
    table = TEXT['en']
    return table[key].format(done=table['done'], **kw)


def format_eth(wei):
    value = Decimal(wei)
    # The default context keeps 28 digits; widen it so scaleb stays exact.
    text = format(value.scaleb(-18, Context(prec=max(28, len(value.as_tuple().digits)))), 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text


def _blocked(language, key, **kw):
    return {'status': 'blocked', 'question': None, 'intent': None, 'summary': _t(language, key, **kw)}


def refusal(key, language):
    return _blocked(language, key)


def clarify(language):
    return {'status': 'needsClarification', 'question': _t(language, 'unclear_question'),
            'intent': None, 'summary': _t(language, 'unclear_summary')}


def _ready(payload, action, milestone_id, summary):
    d = payload['deployment']
    return {'status': 'readyForConfirmation', 'question': None, 'summary': summary,
            'intent': {'projectId': payload['projectId'], 'chainId': d['chainId'],
                       'contractAddress': d['contractAddress'], 'action': action,
                       'milestoneId': milestone_id if action == 'acceptMilestone' else None}}


def decide(parsed, payload):
    lang = 'en'
    kind = parsed['kind']
    mid = parsed['milestoneId']
    snap = payload['snapshot']
    addr = snap['contractAddress']
    if addr is None or addr.lower() != payload['deployment']['contractAddress'].lower():
        return _blocked(lang, 'mismatch')
    milestones = snap['milestones']
    if [m['id'] for m in milestones] != list(range(1, len(milestones) + 1)):
        return _blocked(lang, 'bad_ids')
    if kind == 'unsupported':
        if snap['funded'] and any(not m['paid'] for m in milestones):
            # Say plainly where the money stays, so a dispute is not mistaken for a pending refund.
            return _blocked(lang, 'unsupported_held', balance=format_eth(snap['escrowBalanceWei']))
        return _blocked(lang, 'unsupported')
    if kind == 'unclear':
        return clarify(lang)
    funded = snap['funded']
    if kind == 'query':
        items = '; '.join(_t(lang, 'query_item', id=m['id'], title=m['title'], eth=format_eth(m['amountWei']),
                             state=_t(lang, 'paid' if m['paid'] else 'unpaid')) for m in milestones)
        summary = _t(lang, 'query', balance=format_eth(snap['escrowBalanceWei']),
                     funded=_t(lang, 'yes' if funded else 'no'), items=items)
        return _ready(payload, 'query', None, summary)
    if kind == 'deposit':
        total = format_eth(snap['totalAmountWei'])
        if mid is not None:
            message = payload.get('message') or ''
            if funded or mid not in [m['id'] for m in milestones]:
                return clarify(lang)
            if PAY_WORDS.search(message) or not DEPOSIT_WORDS.search(message):
                # Possibly "pay milestone 1" on an unfunded escrow: say what has to happen first.
                return {'status': 'needsClarification', 'intent': None,
                        'question': _t(lang, 'deposit_or_pay', total=total),
                        'summary': _t(lang, 'unclear_summary')}
            return _ready(payload, 'deposit', None, _t(lang, 'deposit_named', total=total, id=mid))
        if funded:
            return _blocked(lang, 'already_funded')
        return _ready(payload, 'deposit', None, _t(lang, 'deposit', total=total))
    # acceptMilestone
    unpaid = [m for m in milestones if not m['paid']]
    if not unpaid:
        return _blocked(lang, 'all_paid')
    lowest = min(unpaid, key=lambda m: m['id'])
    if mid is None:
        return {'status': 'needsClarification', 'intent': None,
                'question': _t(lang, 'ask_id', id=lowest['id'], title=lowest['title']),
                'summary': _t(lang, 'ask_id_summary')}
    target = next((m for m in milestones if m['id'] == mid), None)
    if target is None:
        return _blocked(lang, 'unknown_id', id=mid)
    if not funded:
        return _blocked(lang, 'unfunded')
    if target['paid']:
        return _blocked(lang, 'is_paid', id=mid)
    if mid != lowest['id']:
        return _blocked(lang, 'out_of_order', next_id=lowest['id'])
    wallet = snap['developerWallet']
    summary = _t(lang, 'accept', id=mid, title=target['title'], eth=format_eth(target['amountWei']),
                 wallet=wallet[:6] + '…' + wallet[-4:])
    return _ready(payload, 'acceptMilestone', mid, summary)
