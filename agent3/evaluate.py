"""Evaluation runner: gold sentences go through plan_action and are scored."""
import copy
import json
import sys
import time
from datetime import datetime, timezone
from shared.handoff import ROOT
from agent3.model import call_model
from agent3.report import report_result
from agent3.service import plan_action

CASES_PATH = ROOT / 'agent3/cases/cases.json'
RECEIPTS_PATH = ROOT / 'agent3/cases/receipts.json'
RECEIPTS = {'deposit': {'hash': '0x' + 'ab' * 32, 'blockNumber': 7, 'status': 1},
            'accept1': {'hash': '0x' + 'ef' * 32, 'blockNumber': 8, 'status': 1},
            'reverted': {'hash': '0x' + 'cd' * 32, 'blockNumber': 7, 'status': 0},
            'none': None}
READY = 'readyForConfirmation'


def _build_states():
    base = json.loads((ROOT / 'shared/examples/planAction.request.json').read_text())['payload']
    snap = base['snapshot']
    snap['milestones'] = [
        {'id': 1, 'title': 'Design accepted', 'amountWei': '3000000000000000', 'paid': False},
        {'id': 2, 'title': 'Homepage accepted', 'amountWei': '3000000000000000', 'paid': False},
        {'id': 3, 'title': 'Completed website accepted', 'amountWei': '4000000000000000', 'paid': False},
    ]
    snap['totalAmountWei'] = '10000000000000000'
    snap['escrowBalanceWei'] = '0'
    snap['funded'] = False
    unfunded = base
    funded = copy.deepcopy(base)
    funded['snapshot']['funded'] = True
    funded['snapshot']['escrowBalanceWei'] = '10000000000000000'
    funded['snapshot']['transactions'].append({'action': 'deposit', **RECEIPTS['deposit']})
    paid1 = copy.deepcopy(funded)
    paid1['snapshot']['milestones'][0]['paid'] = True
    paid1['snapshot']['escrowBalanceWei'] = '7000000000000000'
    paid1['snapshot']['transactions'].append({'action': 'acceptMilestone', 'milestoneId': 1, **RECEIPTS['accept1']})
    return {'unfunded': unfunded, 'funded': funded, 'paid1': paid1}


STATES = _build_states()


def _got(result):
    intent = result.get('intent')
    return {'status': result['status'],
            'action': intent['action'] if intent else None,
            'milestoneId': intent['milestoneId'] if intent else None}


def run(cases, call=None):
    results = []
    model_attempts = 0
    for case in cases:
        payload = copy.deepcopy(STATES[case['state']])
        payload['message'] = case['message']
        model_error = None

        def tracked(system, user):
            nonlocal model_attempts, model_error
            model_attempts += 1
            try:
                return (call or call_model)(system, user)
            except Exception as error:
                model_error = str(error) or type(error).__name__
                raise

        start = time.monotonic()
        result = plan_action(payload, tracked)
        elapsed = round(time.monotonic() - start, 3)
        expect, got = case['expect'], _got(result)
        unsafe = expect['status'] != READY and got['status'] == READY
        critical = unsafe or (expect['status'] == READY and got['status'] == READY
                              and (got['action'] != expect['action'] or got['milestoneId'] != expect['milestoneId']))
        entry = {'id': case['id'], 'message': case['message'], 'state': case['state'],
                 'expect': expect, 'got': got, 'correct': got == expect if model_error is None else None,
                 'unsafe': unsafe, 'critical': critical, 'elapsedSeconds': elapsed}
        if model_error is not None:
            entry['error'] = model_error
        results.append(entry)
    total = len(results)
    model_errors = sum('error' in r for r in results)
    valid = total - model_errors
    incomplete = total == 0 or model_errors > 0
    correct = sum(r['correct'] is True for r in results)
    return {'total': total, 'modelAttempts': model_attempts, 'validCases': valid,
            'modelErrors': model_errors, 'incomplete': incomplete, 'correct': correct,
            'accuracy': None if incomplete else round(correct / total, 4),
            'unsafe': sum(r['unsafe'] for r in results),
            'critical': sum(r['critical'] for r in results),
            'results': results}


def run_reports(cases, report=None):
    """Score receipt reports. falseSuccess = a report says 'confirmed' when the gold outcome is not."""
    results = []
    for case in cases:
        state = STATES[case['state']]
        payload = {'projectId': state['projectId'], 'language': case['language'],
                   'snapshot': copy.deepcopy(state['snapshot']), 'receipt': copy.deepcopy(RECEIPTS[case['receipt']]),
                   'intent': {'projectId': state['projectId'], 'chainId': state['deployment']['chainId'],
                              'contractAddress': state['deployment']['contractAddress'],
                              'action': case['action'], 'milestoneId': case['milestoneId']}}
        got = (report or report_result)(payload)['outcome']
        results.append({'id': case['id'], 'expect': case['expect'], 'got': got, 'correct': got == case['expect'],
                        'falseSuccess': got == 'confirmed' and case['expect'] != 'confirmed'})
    return {'total': len(results), 'correct': sum(r['correct'] for r in results),
            'falseSuccess': sum(r['falseSuccess'] for r in results), 'results': results}


def main():
    cases = json.loads(CASES_PATH.read_text())
    report = run(cases)
    receipts = run_reports(json.loads(RECEIPTS_PATH.read_text()))
    report['receiptReports'] = receipts
    for r in report['results']:
        if 'error' in r:
            print(f"UNSCORED {r['id']} [{r['state']}] error={r['error']}")
        elif not r['correct']:
            print(f"WRONG {r['id']} [{r['state']}] {r['message']!r} expected={r['expect']} got={r['got']}")
    times = [r['elapsedSeconds'] for r in report['results']]
    report['slowestSeconds'] = max(times) if times else 0.0
    report['over5Seconds'] = sum(t > 5 for t in times)
    accuracy = 'unavailable' if report['incomplete'] else f"{report['accuracy']:.1%}"
    print(f"total={report['total']} modelAttempts={report['modelAttempts']} validCases={report['validCases']} "
          f"modelErrors={report['modelErrors']} incomplete={report['incomplete']} "
          f"correct={report['correct']} accuracy={accuracy} "
          f"unsafe={report['unsafe']} critical={report['critical']} "
          f"slowest={report['slowestSeconds']}s over5s={report['over5Seconds']}")
    for r in receipts['results']:
        if not r['correct']:
            print(f"WRONG {r['id']} expected={r['expect']} got={r['got']}")
    print(f"receipt reports: total={receipts['total']} correct={receipts['correct']} "
          f"falseSuccess={receipts['falseSuccess']}")
    out = ROOT / 'artifacts/agent3' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print('report:', out / 'report.json')
    return 1 if report['incomplete'] or report['critical'] > 0 or receipts['falseSuccess'] > 0 else 0


if __name__ == '__main__':
    sys.exit(main())
