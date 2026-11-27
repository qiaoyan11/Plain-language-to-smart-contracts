"""Pure decision rules: a parsed request plus the project state give a PlanResult."""
import re
from decimal import Context, Decimal

# A deposit funds the whole escrow, so a deposit request that also names the milestone it covers
# ("put the rent for Dec 21-25 into escrow") is still a deposit. Without any deposit word the model
# may have misread "pay milestone 1" on an unfunded escrow, so that still asks first.
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
        'deposit_or_pay': 'The escrow is not funded yet, so no milestone can be paid. Deposit the full {total} test ETH '
                          'first? Reply "yes" and I will prepare the deposit for you to review.',
        'already_funded': 'The escrow is already funded, so it cannot be deposited again. {done}',
        'all_paid': 'All milestones are already paid. {done}',
        'unknown_id': 'Milestone #{id} does not exist in this project. {done}',
        'unfunded': 'The escrow is not funded yet, so no milestone can be accepted. {done}',
        'is_paid': 'Milestone #{id} is already paid. {done}',
        'out_of_order': 'Milestones must be accepted in order. The next unpaid milestone is #{next_id}. {done}',
        'accept': 'Accept milestone #{id} "{title}" and pay {eth} test ETH to the provider wallet {wallet}.{more} {done}',
        'accept_more': ' After it, {count} more milestone{s} ({eth} test ETH) stay{verb} in escrow; each is paid only '
                       'when you approve it.',
        'no_review': 'This contract has no review period: the client approves each payment, and nothing is delivered '
                     'or claimed on chain. {done}',
        'deliver': 'Mark milestone #{id} "{title}" as delivered. The client then has {days} to approve it or ask for '
                   'changes; after that the provider can claim the payment. {done}',
        'already_delivered': 'Milestone #{id} is already delivered and in review until {ends}. {done}',
        'not_delivered': 'Milestone #{id} has no delivery awaiting review, so there is nothing to {what}. {done}',
        'review_running': 'The review of milestone #{id} runs until {ends}; the provider can claim the payment after that '
                          'if the client has not responded. {done}',
        'review_over': 'The review of milestone #{id} ended at {ends}, so changes can no longer be requested; the client can '
                       'still approve it, or the provider can claim it. {done}',
        'limit_reached': 'All {limit} change request(s) for milestone #{id} have been used. {done}',
        'request_changes': 'Ask for changes to milestone #{id} "{title}". The delivery is withdrawn, and the review starts '
                           'again when the provider delivers again. {done}',
        'claim': 'Claim milestone #{id} "{title}": its review ended without a response, so {eth} test ETH goes to the '
                 'provider wallet {wallet}.{more} {done}',
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
                       'milestoneId': None if action in ('deposit', 'query') else milestone_id}}


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
            if not DEPOSIT_WORDS.search(message):
                # Possibly "pay milestone 1" on an unfunded escrow: say what has to happen first.
                return {'status': 'needsClarification', 'intent': None,
                        'question': _t(lang, 'deposit_or_pay', total=total),
                        'summary': _t(lang, 'unclear_summary')}
            return _ready(payload, 'deposit', None, _t(lang, 'deposit_named', total=total, id=mid))
        if funded:
            return _blocked(lang, 'already_funded')
        return _ready(payload, 'deposit', None, _t(lang, 'deposit', total=total))
    if kind in ('submitDelivery', 'requestChanges', 'claimMilestone'):
        return _review_action(kind, mid, payload, lang)
    # acceptMilestone
    unpaid = [m for m in milestones if not m['paid']]
    if not unpaid:
        return _blocked(lang, 'all_paid')
    lowest = min(unpaid, key=lambda m: m['id'])
    if mid is None:
        # Milestones are paid in order, so "approve it" can only mean the next unpaid one.
        # The preview names it and its amount before anything is sent.
        mid = lowest['id']
    target = next((m for m in milestones if m['id'] == mid), None)
    if target is None:
        return _blocked(lang, 'unknown_id', id=mid)
    if not funded:
        # Funding comes first, as on escrow platforms: offer the deposit instead of a dead end.
        # A "yes" reply comes back with this question attached (Node keeps it briefly).
        return {'status': 'needsClarification', 'intent': None,
                'question': _t(lang, 'deposit_or_pay', total=format_eth(snap['totalAmountWei'])),
                'summary': _t(lang, 'unfunded')}
    if target['paid']:
        return _blocked(lang, 'is_paid', id=mid)
    if mid != lowest['id']:
        return _blocked(lang, 'out_of_order', next_id=lowest['id'])
    wallet = snap['developerWallet']
    # "Pay everything that's left" still pays one milestone per approval: say what remains after it.
    later = [m for m in unpaid if m['id'] != mid]
    more = _t(lang, 'accept_more', count=len(later), s='' if len(later) == 1 else 's',
              verb='s' if len(later) == 1 else '',
              eth=format_eth(sum(int(m['amountWei']) for m in later))) if later else ''
    summary = _t(lang, 'accept', id=mid, title=target['title'], eth=format_eth(target['amountWei']),
                 wallet=wallet[:6] + '…' + wallet[-4:], more=more)
    return _ready(payload, 'acceptMilestone', mid, summary)


def _when(seconds):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(seconds, timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


def _review_action(kind, mid, payload, lang):
    """v2: a delivery by the provider, a change request by the client, or the provider's claim.
    The contract enforces the same rules; these only explain why a request cannot go ahead."""
    snap = payload['snapshot']
    review = snap.get('review')
    if not review:
        return _blocked(lang, 'no_review')
    milestones = snap['milestones']
    unpaid = [m for m in milestones if not m['paid']]
    if not unpaid:
        return _blocked(lang, 'all_paid')
    if not snap['funded']:
        return {'status': 'needsClarification', 'intent': None,
                'question': _t(lang, 'deposit_or_pay', total=format_eth(snap['totalAmountWei'])),
                'summary': _t(lang, 'unfunded')}
    lowest = min(unpaid, key=lambda m: m['id'])
    mid = lowest['id'] if mid is None else mid
    target = next((m for m in milestones if m['id'] == mid), None)
    if target is None:
        return _blocked(lang, 'unknown_id', id=mid)
    if target['paid']:
        return _blocked(lang, 'is_paid', id=mid)
    if mid != lowest['id']:
        return _blocked(lang, 'out_of_order', next_id=lowest['id'])
    period, now = review['periodSeconds'], review['chainTime']
    delivered = target.get('deliveredAt') or 0
    ends = delivered + period
    if kind == 'submitDelivery':
        if delivered:
            return _blocked(lang, 'already_delivered', id=mid, ends=_when(ends))
        days = round(period / 86400, 1)
        days_text = f'{days:g} day' + ('' if days == 1 else 's') if period >= 86400 else f'{period // 60} minutes'
        return _ready(payload, 'submitDelivery', mid, _t(lang, 'deliver', id=mid, title=target['title'], days=days_text))
    if not delivered:
        return _blocked(lang, 'not_delivered', id=mid, what='review' if kind == 'requestChanges' else 'claim')
    if kind == 'requestChanges':
        if now >= ends:
            return _blocked(lang, 'review_over', id=mid, ends=_when(ends))
        limit = review['changeRequestLimit']
        if limit and target.get('changeRequests', 0) >= limit:
            return _blocked(lang, 'limit_reached', id=mid, limit=limit)
        return _ready(payload, 'requestChanges', mid, _t(lang, 'request_changes', id=mid, title=target['title']))
    if now < ends:
        return _blocked(lang, 'review_running', id=mid, ends=_when(ends))
    wallet = snap['developerWallet']
    later = [m for m in unpaid if m['id'] != mid]
    more = _t(lang, 'accept_more', count=len(later), s='' if len(later) == 1 else 's', verb='s' if len(later) == 1 else '',
              eth=format_eth(sum(int(m['amountWei']) for m in later))) if later else ''
    return _ready(payload, 'claimMilestone', mid, _t(lang, 'claim', id=mid, title=target['title'],
                                                     eth=format_eth(target['amountWei']), wallet=wallet[:6] + '…' + wallet[-4:], more=more))
