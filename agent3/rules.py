"""Pure decision rules: a parsed request plus the project state give a PlanResult."""
import re
from decimal import Decimal

TEXT = {
    'en': {
        'done': 'No transaction has been sent.',
        'mismatch': 'The project record does not match the deployed contract address. {done}',
        'unsupported': 'This request is not supported. You can ask about the escrow, deposit funds, or accept a milestone. {done}',
        'unclear_summary': 'The request is not clear enough to act on. {done}',
        'unclear_question': 'What do you want to do: check the escrow, deposit funds, or accept a milestone?',
        'query': 'Escrow balance: {balance} ETH. Funded: {funded}. Milestones: {items}. {done}',
        'query_item': '#{id} {title}, {eth} ETH, {state}',
        'yes': 'yes', 'no': 'no', 'paid': 'paid', 'unpaid': 'unpaid',
        'deposit': 'Deposit {total} ETH into the escrow. {done}',
        'already_funded': 'The escrow is already funded, so it cannot be deposited again. {done}',
        'all_paid': 'All milestones are already paid. {done}',
        'ask_id_summary': 'The milestone to accept is not specified. {done}',
        'ask_id': 'Which milestone do you want to accept? The next unpaid milestone is #{id} "{title}".',
        'unknown_id': 'Milestone #{id} does not exist in this project. {done}',
        'unfunded': 'The escrow is not funded yet, so no milestone can be accepted. {done}',
        'is_paid': 'Milestone #{id} is already paid. {done}',
        'out_of_order': 'Milestones must be accepted in order. The next unpaid milestone is #{next_id}. {done}',
        'accept': 'Accept milestone #{id} "{title}" and pay {eth} ETH to the developer wallet {wallet}. {done}',
        'model_error': 'The request could not be understood because of a service error. Please try again. {done}',
        'too_long': 'The message is too long. Please shorten it and try again. {done}',
    },
    'zh': {
        'done': '尚未发送任何交易。',
        'mismatch': '项目记录与已部署的合约地址不一致。{done}',
        'unsupported': '暂不支持此请求。你可以查询托管状态、存入资金或验收里程碑。{done}',
        'unclear_summary': '请求不够明确，无法执行。{done}',
        'unclear_question': '你想做什么：查询托管状态、存入资金，还是验收里程碑？',
        'query': '托管余额：{balance} ETH。已注资：{funded}。里程碑：{items}。{done}',
        'query_item': '#{id} {title}，{eth} ETH，{state}',
        'yes': '是', 'no': '否', 'paid': '已支付', 'unpaid': '未支付',
        'deposit': '向托管合约存入 {total} ETH。{done}',
        'already_funded': '托管合约已注资，不能重复存入。{done}',
        'all_paid': '所有里程碑均已支付。{done}',
        'ask_id_summary': '未指定要验收的里程碑。{done}',
        'ask_id': '你要验收哪个里程碑？下一个未支付的里程碑是 #{id}「{title}」。',
        'unknown_id': '本项目中不存在里程碑 #{id}。{done}',
        'unfunded': '托管合约尚未注资，无法验收里程碑。{done}',
        'is_paid': '里程碑 #{id} 已支付。{done}',
        'out_of_order': '里程碑必须按顺序验收。下一个未支付的里程碑是 #{next_id}。{done}',
        'accept': '验收里程碑 #{id}「{title}」，并向开发者钱包 {wallet} 支付 {eth} ETH。{done}',
        'model_error': '由于服务错误，无法理解该请求。请重试。{done}',
        'too_long': '消息过长，请缩短后重试。{done}',
    },
}


def _t(language, key, **kw):
    table = TEXT.get(language, TEXT['en'])
    return table[key].format(done=table['done'], **kw)


def guess_language(message):
    return 'zh' if re.search('[一-鿿]', message) else 'en'


def format_eth(wei):
    text = format(Decimal(wei) / 10 ** 18, 'f')
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
    lang = parsed['language']
    kind = parsed['kind']
    mid = parsed['milestoneId']
    snap = payload['snapshot']
    addr = snap['contractAddress']
    if addr is None or addr.lower() != payload['deployment']['contractAddress'].lower():
        return _blocked(lang, 'mismatch')
    if kind == 'unsupported':
        return _blocked(lang, 'unsupported')
    if kind == 'unclear':
        return clarify(lang)
    milestones = snap['milestones']
    funded = snap['funded']
    if kind == 'query':
        items = '; '.join(_t(lang, 'query_item', id=m['id'], title=m['title'], eth=format_eth(m['amountWei']),
                             state=_t(lang, 'paid' if m['paid'] else 'unpaid')) for m in milestones)
        summary = _t(lang, 'query', balance=format_eth(snap['escrowBalanceWei']),
                     funded=_t(lang, 'yes' if funded else 'no'), items=items)
        return _ready(payload, 'query', None, summary)
    if kind == 'deposit':
        if funded:
            return _blocked(lang, 'already_funded')
        return _ready(payload, 'deposit', None, _t(lang, 'deposit', total=format_eth(snap['totalAmountWei'])))
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
