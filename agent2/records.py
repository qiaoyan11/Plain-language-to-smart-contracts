"""Persist paid outputs and tool results locally, including interrupted runs."""
from datetime import datetime, timezone
import json
from uuid import uuid4
from shared.handoff import ROOT
from flows.generation import run_generation


def run_and_save(request, *, initial_bundle=None, resumed_from=None):
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8]
    directory = ROOT / 'artifacts/agent2' / run_id
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)

    def save(name, data):
        (directory / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

    save('request.json', request)
    save('origin.json', {'resumedFrom': resumed_from, 'formalExperiment': False})

    def record(item):
        # JSONL is append-only within this newly allocated run; no model-chosen paths.
        with (directory / 'events.jsonl').open('a') as stream:
            stream.write(json.dumps(item, ensure_ascii=False) + '\n')

    try:
        run = run_generation(request, initial_bundle=initial_bundle, on_record=record)
    except Exception as error:
        save('interrupted.json', {'exceptionType': type(error).__name__, 'status': 'toolError'})
        raise
    save('run.json', run)
    save('response.json', run['response'])
    save('compilation.json', run['compilation'])
    result = run['response']['result']
    save('validation-report.json', result['validationReport'])
    if result['sourceBundle']:
        bundle = result['sourceBundle']
        (directory / 'GeneratedMilestoneEscrow.sol').write_text(bundle['sources'][bundle['entryFile']])
        (directory / 'IMilestoneEscrow.sol').write_text(bundle['sources']['IMilestoneEscrow.sol'])
    summary = {'runDirectory': str(directory), 'status': result['status'],
               'compilation': (run['compilation'] or {}).get('status'), 'error': run['error'],
               'model': run['metadata'].get('returnedModel'), 'usage': run['metadata']['usage'],
               'apiCalls': run['metadata']['apiCalls'], 'callAttempts': run['metadata']['callAttempts'],
               'sourceAttempts': len(result['attempts']), 'stopReason': run['stopReason'],
               'elapsedSeconds': run['elapsedSeconds'],
               'independentValidation': (result['validationReport'] or {}).get('status', 'not run'),
               'resumedFrom': resumed_from, 'formalExperiment': False, 'deployed': False}
    save('summary.json', summary)
    return run, summary
