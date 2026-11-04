"""Command line: run independent development validation and save the report.

  python -m validation --run-dir artifacts/agent2/<run-id>
  python -m validation --spec spec.json --bundle source-bundle.json [--out DIR]

--run-dir reads request.json (payload.spec) and response.json (result.sourceBundle) from an
Agent 2 run folder and writes validation-report.json and validation-evidence.json into it (or --out).
Existing report files are never overwritten; pass a new --out directory instead.
Exit code: 0 passed, 1 failed, 2 toolError.
"""
import argparse
import json
import sys
from pathlib import Path

from .core import validate_development_detailed


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python -m validation')
    ap.add_argument('--run-dir', type=Path)
    ap.add_argument('--spec', type=Path)
    ap.add_argument('--bundle', type=Path)
    ap.add_argument('--out', type=Path)
    a = ap.parse_args(argv)
    agent2_compilation = None
    if a.run_dir:
        spec = json.loads((a.run_dir / 'request.json').read_text())['payload']['spec']
        bundle = json.loads((a.run_dir / 'response.json').read_text())['result']['sourceBundle']
        out_dir = a.out or a.run_dir
        compilation = a.run_dir / 'compilation.json'
        if compilation.exists():
            agent2_compilation = json.loads(compilation.read_text())
    elif a.spec and a.bundle:
        spec, bundle, out_dir = json.loads(a.spec.read_text()), json.loads(a.bundle.read_text()), a.out
    else:
        ap.error('use --run-dir, or --spec together with --bundle')
    if bundle is None:
        print('No sourceBundle in input; nothing to validate.', file=sys.stderr)
        return 2
    report, evidence = validate_development_detailed(spec, bundle)
    if agent2_compilation is not None:
        # Informational cross-check only; Agent 2's self-reported build is never used for the verdict.
        ours = (evidence.get('compilation') or {}).get('entry') or {}
        theirs = (agent2_compilation.get('artifact') or {}).get('bytecode')
        evidence['agent2SelfReportedBytecodeMatchesRecompilation'] = bool(ours) and theirs == ours.get('bytecode')
    if out_dir:
        for name in ('validation-report.json', 'validation-evidence.json'):
            if (out_dir / name).exists():  # earlier reports are records; never overwrite them
                print(f'{out_dir / name} already exists; choose a new --out directory', file=sys.stderr)
                return 2
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / 'validation-report.json').write_text(json.dumps(report, indent=2) + '\n')
        (out_dir / 'validation-evidence.json').write_text(json.dumps(evidence, indent=2, default=str) + '\n')
    print(json.dumps(report, indent=2))
    return {'passed': 0, 'failed': 1}.get(report['status'], 2)


if __name__ == '__main__':
    sys.exit(main())
