"""One request per process. All stdout is a single JSON envelope.
Agent 2 and Agent 3 can each opt into live mode; Agent 1 is a fixture. Receipt reports use no model.
"""
import json
import os
import sys
from shared.handoff import validate_request, validate_response
from agent1.stub import clarify
from agent2.stub import generate as generate_stub
from agent3.report import report_result
from agent3.stub import plan_action

MAX_BYTES = 1024 * 1024


def dispatch(request):
    validate_request(request)
    mode = os.getenv('AGENT2_MODE', 'stub')
    if mode not in ('stub', 'live'):
        raise ValueError('AGENT2_MODE must be stub or live')
    generate = generate_stub
    if request['operation'] == 'generate' and mode == 'live':
        from agent2.service import generate
        print('LIVE Agent 2: explicit generation/validation budget; no deployment.', file=sys.stderr)
    elif request['operation'] == 'planAction' and os.getenv('AGENT3_MODE', 'stub') == 'live':
        print('LIVE Agent 3: plans one operation; no signing and no transaction.', file=sys.stderr)
    elif request['operation'] == 'reportAction':
        print('Agent 3 receipt report: fixed rules, no model call, no transaction.', file=sys.stderr)
    else:
        print('STUB MODE: fixtures only; no AI, independent validation, or transactions.', file=sys.stderr)
    result = {'clarify': clarify, 'generate': generate, 'planAction': plan_action,
              'reportAction': report_result}[request['operation']](request['payload'])
    response = {'interfaceVersion': 1, 'requestId': request['requestId'], 'status': 'ok', 'result': result, 'errors': []}
    validate_response(request, response)
    return response


def main():
    request = None
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError('Input exceeds 1 MiB')
        request = json.loads(raw)
        response = dispatch(request)
    except Exception as error:
        print(str(error), file=sys.stderr)
        rid = request.get('requestId') if isinstance(request, dict) else None
        response = {'interfaceVersion': 1, 'requestId': rid if isinstance(rid, str) and rid else 'invalid-request',
                    'status': 'error', 'result': None,
                    'errors': [{'code': 'HANDOFF_ERROR', 'message': 'Request or module result rejected; see stderr.', 'field': None}]}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
