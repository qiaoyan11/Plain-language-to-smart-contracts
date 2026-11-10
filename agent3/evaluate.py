"""Evaluation runner: gold sentences go through plan_action and are scored."""
import copy
import json
import sys
import time
from datetime import datetime, timezone
from shared.handoff import ROOT
from agent3.model import call_model
from agent3.service import plan_action

CASES_PATH = ROOT / 'agent3/cases/cases.json'
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
    paid1 = copy.deepcopy(funded)
    paid1['snapshot']['milestones'][0]['paid'] = True
    paid1['snapshot']['escrowBalanceWei'] = '7000000000000000'
    return {'unfunded': unfunded, 'funded': funded, 'paid1': paid1}


STATES = _build_states()


def _got(result):
    intent = result.get('intent')
    return {'status': result['status'],
            'action': intent['action'] if intent else None,
            'milestoneId': intent['milestoneId'] if intent else None}


def run(cases, call=None):
    results = []
    for case in cases:
        payload = copy.deepcopy(STATES[case['state']])
        payload['message'] = case['message']
        errors = []

        def tracked(system, user, model=None, _errors=errors):
            try:
                return (call or call_model)(system, user)
            except Exception as error:
                _errors.append(str(error) or type(error).__name__)
                raise

        start = time.monotonic()
        result = plan_action(payload, tracked)
        elapsed = round(time.monotonic() - start, 3)
        expect, got = case['expect'], _got(result)
        unsafe = expect['status'] != READY and got['status'] == READY
        critical = unsafe or (expect['status'] == READY and got['status'] == READY
                              and (got['action'] != expect['action'] or got['milestoneId'] != expect['milestoneId']))
        entry = {'id': case['id'], 'message': case['message'], 'state': case['state'],
                 'expect': expect, 'got': got, 'correct': got == expect,
                 'unsafe': unsafe, 'critical': critical, 'elapsedSeconds': elapsed}
        if errors:
            entry['error'] = errors[0]
        results.append(entry)
    total = len(results)
    correct = sum(r['correct'] for r in results)
    return {'total': total, 'correct': correct,
            'accuracy': round(correct / total, 4) if total else 0.0,
            'unsafe': sum(r['unsafe'] for r in results),
            'critical': sum(r['critical'] for r in results),
            'results': results}


def main():
    cases = json.loads(CASES_PATH.read_text())
    report = run(cases)
    for r in report['results']:
        if not r['correct']:
            note = f" error={r['error']}" if 'error' in r else ''
            print(f"WRONG {r['id']} [{r['state']}] {r['message']!r} expected={r['expect']} got={r['got']}{note}")
    times = [r['elapsedSeconds'] for r in report['results']]
    report['slowestSeconds'] = max(times) if times else 0.0
    report['over5Seconds'] = sum(t > 5 for t in times)
    print(f"total={report['total']} correct={report['correct']} accuracy={report['accuracy']:.1%} "
          f"unsafe={report['unsafe']} critical={report['critical']} "
          f"slowest={report['slowestSeconds']}s over5s={report['over5Seconds']}")
    out = ROOT / 'artifacts/agent3' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print('report:', out / 'report.json')
    return 1 if report['critical'] > 0 else 0


if __name__ == '__main__':
    sys.exit(main())
