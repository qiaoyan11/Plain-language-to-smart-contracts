"""Fixture mode stays default. --live enables explicitly budgeted model calls."""
import argparse
import json
from pathlib import Path
import sys
from shared.handoff import validate_request, validate_response


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('request', help='JSON request envelope with explicit runConfig')
    parser.add_argument('--live', action='store_true', help='Run real generation/validation; obey maxRepairs')
    parser.add_argument('--resume-run', help='Revalidate original source from a saved run; diagnostic continuation, not a formal experiment')
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text())
    validate_request(request)
    if request['operation'] != 'generate':
        raise SystemExit('Wrong operation for agent2')
    if not args.live:
        if args.resume_run:
            parser.error('--resume-run requires --live')
        from flows.worker import dispatch
        print(json.dumps(dispatch(request), ensure_ascii=False))
        return
    initial_bundle = None
    if args.resume_run:
        origin = Path(args.resume_run).resolve()
        original_request = json.loads((origin / 'request.json').read_text())
        original_response = json.loads((origin / 'response.json').read_text())
        validate_request(original_request)
        validate_response(original_request, original_response)
        for field in ('spec', 'confirmation'):
            if original_request['payload'][field] != request['payload'][field]:
                raise SystemExit('Resume requires exactly the original confirmed specification.')
        initial_bundle = original_response['result']['sourceBundle']
        if initial_bundle is None:
            raise SystemExit('Original run has no source to resume.')
    config = request['payload']['runConfig']
    max_calls = config['maxRepairs'] + (0 if initial_bundle is not None else 1)
    print(f'LIVE: at most {max_calls} new model call(s); mode={config["validationMode"]}; no deployment.', file=sys.stderr)
    from agent2.records import run_and_save
    try:
        run, summary = run_and_save(request, initial_bundle=initial_bundle,
                                    resumed_from=str(origin) if args.resume_run else None)
    except Exception as error:
        print(f'Agent 2 stopped: {type(error).__name__}. Check request settings and installed dependencies.', file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if run['response']['result']['status'] in ('failed', 'toolError'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
