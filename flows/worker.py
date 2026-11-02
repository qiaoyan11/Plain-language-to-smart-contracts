"""One request per process. All stdout is a single JSON envelope.
This fixture dispatcher will be replaced by a LangGraph workflow; no graph yet.
"""
import json
import sys
from shared.handoff import validate_request, validate_response
from agent1.stub import clarify
from agent2.stub import generate
from agent3.stub import plan_action

MAX_BYTES = 1024 * 1024


def dispatch(request):
    validate_request(request)
    print('STUB MODE: fixtures only; no AI, independent validation, or transactions.', file=sys.stderr)
    result = {'clarify': clarify, 'generate': generate, 'planAction': plan_action}[request['operation']](request['payload'])
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
