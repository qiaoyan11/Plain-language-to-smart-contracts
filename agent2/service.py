"""Public generate boundary; detailed local run records are available through CLI."""
import json
import sys
from agent2.records import run_and_save


def generate(payload):
    request = {'interfaceVersion': 1, 'requestId': 'agent2-direct', 'operation': 'generate', 'payload': payload}
    run, summary = run_and_save(request)
    print(json.dumps({'mode': 'live', 'compilation': (run['compilation'] or {}).get('status'),
                      'error': run['error'], 'metadata': run['metadata'], 'runDirectory': summary['runDirectory']}), file=sys.stderr)
    return run['response']['result']
