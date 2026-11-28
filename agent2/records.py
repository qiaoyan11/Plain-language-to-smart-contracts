"""Persist paid outputs and tool results locally, including interrupted runs."""
from datetime import datetime, timezone
import json
import sys
from uuid import uuid4
from shared.handoff import ROOT
from flows.generation import run_generation


PROGRESS_PREFIX = 'ACCORD_PROGRESS '


def progress_for(event, config):
    """The stage a user should see after one recorded event, or None.

    Attempts count from 1. A failed check is followed by a repair only while the run's repair
    budget lasts and its feedback setting allows repairs; flows.generation decides the same way.
    """
    kind, attempt = event.get('kind'), event.get('attempt', 0) + 1
    if kind == 'source':
        return {'stage': 'checking', 'attempt': attempt}
    if kind != 'validation':
        return None
    if event.get('status') == 'validated':
        return {'stage': 'finishing', 'attempt': attempt}
    repairs = config.get('maxRepairs', 0) if config.get('feedbackSetting') not in ('A', 'baseline') else 0
    if event.get('status') == 'failed' and attempt <= repairs:
        report = event.get('validationReport') or {}
        failed = [c['name'] for c in report.get('checks', []) if c.get('status') == 'failed']
        return {'stage': 'repairing', 'attempt': attempt + 1, 'failedChecks': failed}
    return None


def emit_progress(item):
    # One line on stderr; the local backend shows it while the run is in progress.
    print(PROGRESS_PREFIX + json.dumps(item), file=sys.stderr, flush=True)


def run_and_save(request, *, initial_bundle=None, resumed_from=None, on_progress=emit_progress):
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8]
    directory = ROOT / 'artifacts/agent2' / run_id
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)

    def save(name, data):
        (directory / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

    save('request.json', request)
    save('origin.json', {'resumedFrom': resumed_from, 'formalExperiment': False})

    config = request['payload'].get('runConfig') or {}

    def record(item):
        # JSONL is append-only within this newly allocated run; no model-chosen paths.
        with (directory / 'events.jsonl').open('a') as stream:
            stream.write(json.dumps(item, ensure_ascii=False) + '\n')
        stage = progress_for(item, config)
        if stage and on_progress:
            on_progress(stage)

    if on_progress and initial_bundle is None:
        on_progress({'stage': 'writing', 'attempt': 1})
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
        for name in ('IMilestoneEscrow.sol', 'IMilestoneReviewEscrow.sol'):
            if name in bundle['sources']:
                (directory / name).write_text(bundle['sources'][name])
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
