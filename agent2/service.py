"""Public generate boundary; detailed local run records are available through CLI."""
import json
import sys
from flows.generation import run_generation


def generate(payload):
    request = {'interfaceVersion': 1, 'requestId': 'agent2-direct', 'operation': 'generate', 'payload': payload}
    run = run_generation(request)
    print(json.dumps({'mode': 'live', 'compilation': (run['compilation'] or {}).get('status'),
                      'error': run['error'], 'metadata': run['metadata']}), file=sys.stderr)
    return run['response']['result']
