"""Report the outcome of a confirmed action from the transaction receipt. No model call."""
from shared.handoff import validate
from agent3.rules import format_eth

OUTCOMES = ('confirmed', 'failed', 'unverified')
ACTIONS = ('deposit', 'acceptMilestone')

TEXT = {
    'en': {
        'deposit_ok': 'Deposit confirmed: {total} ETH is now in the escrow. Transaction {tx}, block {block}.',
        'accept_ok': 'Milestone #{id} "{title}" is paid: {eth} ETH was sent to the developer wallet {wallet}. '
                     'Transaction {tx}, block {block}.',
        'deposit_none': 'no funds were deposited',
        'accept_none': 'milestone #{id} was not paid',
        'reverted': 'The transaction failed, so nothing changed: {what}. Transaction {tx}.',
        'no_receipt': 'No transaction was confirmed, so nothing changed: {what}.',
        'unverified': 'The receipt reports success, but the contract state does not show the change. '
                      'Check the escrow status before you try again. Transaction {tx}.',
        'mismatch': 'The receipt cannot be matched to this project. Check the escrow status before you try again.',
    },
    'zh': {
        'deposit_ok': '存款已确认：托管合约中现有 {total} ETH。交易 {tx}，区块 {block}。',
        'accept_ok': '里程碑 #{id}「{title}」已支付：已向开发者钱包 {wallet} 转入 {eth} ETH。交易 {tx}，区块 {block}。',
        'deposit_none': '没有存入任何资金',
        'accept_none': '里程碑 #{id} 没有支付',
        'reverted': '交易失败，状态没有变化：{what}。交易 {tx}。',
        'no_receipt': '没有任何交易被确认，状态没有变化：{what}。',
        'unverified': '回执显示成功，但合约状态中看不到这次变化。请先查询托管状态，再决定是否重试。交易 {tx}。',
        'mismatch': '回执无法与本项目对应。请先查询托管状态，再决定是否重试。',
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
    """Only a receipt with status 1 and a matching contract state gives 'confirmed'."""
    _check(payload)
    validate('ReportInput', payload)
    intent, receipt, snap = payload['intent'], payload['receipt'], payload['snapshot']
    text = TEXT.get(payload['language'], TEXT['en'])
    action, mid = intent['action'], intent['milestoneId']
    what = text['deposit_none'] if action == 'deposit' else text['accept_none'].format(id=mid)
    if receipt is None:
        return _result('failed', text['no_receipt'].format(what=what))
    tx = receipt['hash'][:10] + '…' + receipt['hash'][-6:]
    if receipt['status'] != 1:
        return _result('failed', text['reverted'].format(what=what, tx=tx))
    address = snap['contractAddress']
    if (payload['projectId'] != snap['id'] or intent.get('projectId') != snap['id']
            or address is None or address.lower() != intent['contractAddress'].lower()):
        return _result('unverified', text['mismatch'])
    if action == 'deposit':
        if not snap['funded']:
            return _result('unverified', text['unverified'].format(tx=tx))
        return _result('confirmed', text['deposit_ok'].format(
            total=format_eth(snap['totalAmountWei']), tx=tx, block=receipt['blockNumber']))
    target = next((m for m in snap['milestones'] if m['id'] == mid), None)
    if target is None or not target['paid']:
        return _result('unverified', text['unverified'].format(tx=tx))
    wallet = snap['developerWallet']
    return _result('confirmed', text['accept_ok'].format(
        id=mid, title=target['title'], eth=format_eth(target['amountWei']),
        wallet=wallet[:6] + '…' + wallet[-4:], tx=tx, block=receipt['blockNumber']))
