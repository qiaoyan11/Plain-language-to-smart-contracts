"""Fixture mode remains default. --live explicitly enables one paid model call."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from uuid import uuid4
from shared.handoff import ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('request', help='JSON request envelope')
    parser.add_argument('--live', action='store_true', help='Make one real OpenAI call and compile the output')
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text())
    if request.get('operation') != 'generate':
        raise SystemExit('Wrong operation for agent2')
    if not args.live:
        from flows.worker import dispatch
        print(json.dumps(dispatch(request), ensure_ascii=False))
        return
    from flows.generation import run_generation
    print('LIVE: one generation call, then local compilation; no deployment or repair.', file=sys.stderr)
    # Always save in a new ignored folder. Model output never chooses filesystem paths.
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8]
    directory = ROOT / 'artifacts/agent2' / run_id
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        run = run_generation(request)
    except Exception as error:
        # Do not persist arbitrary library exception text (it could contain request headers).
        print(f'Agent 2 stopped: {type(error).__name__}. Check request settings and installed dependencies.', file=sys.stderr)
        raise SystemExit(1) from None
    def save(name, data):
        (directory / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    save('request.json', request)
    save('run.json', run)
    save('response.json', run['response'])
    save('compilation.json', run['compilation'])
    bundle = run['response']['result']['sourceBundle']
    if bundle:
        # Only these two fixed filenames are written by the trusted packager.
        for name in ('GeneratedMilestoneEscrow.sol', 'IMilestoneEscrow.sol'):
            (directory / name).write_text(bundle['sources'][name])
    summary = {'runDirectory': str(directory), 'status': run['response']['result']['status'],
               'compilation': (run['compilation'] or {}).get('status'), 'error': run['error'],
               'model': run['metadata'].get('returnedModel'), 'usage': run['metadata'].get('usage'),
               'elapsedSeconds': run['elapsedSeconds'], 'independentValidation': 'not run', 'deployed': False}
    save('summary.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if run['response']['result']['status'] in ('failed', 'toolError'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
