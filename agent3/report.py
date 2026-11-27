"""Report the outcome of a confirmed action from the transaction receipt. No model call."""
from shared.handoff import receipt_outcome, validate
from agent3.rules import format_eth

OUTCOMES = ('confirmed', 'failed', 'unverified')
ACTIONS = ('deposit', 'acceptMilestone')

TEXT = {
    'en': {
        'deposit_ok': 'Deposit confirmed. Current escrow balance: {balance} test ETH. Transaction {tx}, block {block}.',
        'accept_ok': 'Milestone #{id} "{title}" is paid: {eth} test ETH was sent to the provider wallet {wallet}. '
                     'Transaction {tx}, block {block}.',
        'reverted': 'Transaction {tx} reverted. This attempt failed.',
        'no_receipt': 'No receipt is available yet. Check the transaction status before retrying.',
        'unverified': 'The project records and contract state do not verify this operation. '
                      'Check transaction {tx} before retrying.',
    },
}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _check(payload):
    _require(isinstance(payload, dict) and set(payload) == {'projectId', 'intent', 'receipt', 'snapshot', 'language'},
             'Invalid report input')
    validate('ProjectSnapshot', payload['snapshot'])
    intent, receipt = payload['intent'], payload['receipt']
    _require(isinstance(intent, dict) and intent.get('action') in ACTIONS, 'Report needs a deposit or acceptance intent')
    mid = intent.get('milestoneId')
    _require((mid is not None) == (intent['action'] == 'acceptMilestone'), 'Invalid milestone argument')
    _require(mid is None or (type(mid) is int and 1 <= mid <= 5), 'Invalid milestone argument')
    _require(isinstance(intent.get('contractAddress'), str), 'Invalid contract address')
    if receipt is not None:
        _require(isinstance(receipt, dict) and isinstance(receipt.get('hash'), str)
                 and type(receipt.get('blockNumber')) is int and receipt.get('status') in (0, 1)
                 and type(receipt['status']) is int, 'Invalid receipt')


def _result(outcome, summary):
    return validate('ReportResult', {'outcome': outcome, 'summary': summary})


def report_result(payload):
    """Describe the transaction evidence and, for deposits, the observed balance."""
    _check(payload)
    validate('ReportInput', payload)
    intent, receipt, snap = payload['intent'], payload['receipt'], payload['snapshot']
    # Keep accepting legacy ReportInput.language values without changing output language.
    text = TEXT['en']
    action, mid = intent['action'], intent['milestoneId']
    if receipt is None:
        return _result('unverified', text['no_receipt'])
    tx = receipt['hash'][:10] + '…' + receipt['hash'][-6:]
    outcome = receipt_outcome(payload)
    if outcome == 'failed':
        return _result('failed', text['reverted'].format(tx=tx))
    if outcome == 'unverified':
        return _result('unverified', text['unverified'].format(tx=tx))
    if action == 'deposit':
        return _result('confirmed', text['deposit_ok'].format(
            balance=format_eth(snap['escrowBalanceWei']), tx=tx, block=receipt['blockNumber']))
    target = next(m for m in snap['milestones'] if m['id'] == mid and m['paid'])
    wallet = snap['developerWallet']
    return _result('confirmed', text['accept_ok'].format(
        id=mid, title=target['title'], eth=format_eth(target['amountWei']),
        wallet=wallet[:6] + '…' + wallet[-4:], tx=tx, block=receipt['blockNumber']))
