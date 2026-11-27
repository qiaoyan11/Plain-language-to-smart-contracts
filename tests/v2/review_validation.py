"""Independent development validation for v2 review-period contracts (IMilestoneReviewEscrow).

The v1 validator in validation/ runs unchanged first: recompilation, the v1 interface, Slither and
the v1 clause suite (a v2 contract must still behave as v1 when the client approves). This module
then checks the v2 interface and runs the review clause suite (node/review-clause-tests.cjs) on the
same recompiled contract, and returns one ValidationReport. Like the v1 validator, it trusts nothing
in the bundle except its source files. Loaded by file path from flows/generation.py.
"""
import copy
import json
import shutil
import subprocess
from pathlib import Path

from shared.handoff import ROOT, validate
from validation import core

INTERFACE_NAME = 'IMilestoneReviewEscrow.sol'
INTERFACE_FILE = ROOT / 'contracts' / INTERFACE_NAME
SUITE = 'review-v1'
SUITE_VERSION = f'{core.SUITE_VERSION};{SUITE}'
EXPECTED_CLAUSES = [
    'review-constants', 'review-claim-after-period', 'review-claim-needs-delivery', 'review-access', 'review-unfunded',
    'review-order', 'review-changes-restart', 'review-changes-too-late', 'review-client-approves', 'review-change-limit',
    'review-recipient-rejects', 'review-reentry']
NODE_DIR = Path(__file__).resolve().parent / 'node'


def is_review_spec(spec):
    return bool(spec.get('reviewPeriodSeconds'))


def _node(script, payload, timeout):
    node = shutil.which('node')
    if not node:
        raise core.ToolFailure('node executable not found on PATH')
    try:
        proc = subprocess.run([node, '--max-old-space-size=512', str(NODE_DIR / script)], input=json.dumps(payload),
                              capture_output=True, text=True, cwd=ROOT, timeout=timeout, env=core._env())
    except subprocess.TimeoutExpired:
        raise core.ToolFailure(f'{script} timed out after {timeout} s')
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    try:
        out = json.loads(lines[-1])
    except (IndexError, ValueError):
        raise core.ToolFailure(f'{script} returned no JSON (exit {proc.returncode}): {proc.stderr[-500:]}')
    if out.get('toolError'):
        raise core.ToolFailure(out['toolError'])
    return out


def _interface_findings(bundle, abi):
    findings = []
    if bundle['sources'].get(INTERFACE_NAME) != INTERFACE_FILE.read_text():
        findings.append(core._finding('INTERFACE_FILE_MODIFIED', 'error',
                                      f'Bundled {INTERFACE_NAME} is missing or differs from the frozen v2 interface.', INTERFACE_NAME))
    for signature in _node('interface-check.cjs', {'abi': abi, 'buildSettings': bundle['buildSettings']}, timeout=120)['missing']:
        findings.append(core._finding('INTERFACE_MISMATCH', 'error',
                                      f'Missing or different from IMilestoneReviewEscrow v2: {signature}', bundle['entryFile']))
    return findings


def _review_clauses(spec, entry, bundle):
    out = _node('review-clause-tests.cjs', {
        'abi': entry['abi'], 'bytecode': entry['bytecode'], 'specAmounts': [m['amountWei'] for m in spec['milestones']],
        'reviewPeriodSeconds': spec['reviewPeriodSeconds'], 'changeRequestLimit': spec.get('changeRequestLimit', 0),
        'buildSettings': bundle['buildSettings']}, timeout=240)
    results = out['results']
    if out.get('suite') != SUITE or [r['id'] for r in results] != EXPECTED_CLAUSES:
        raise core.ToolFailure('review clause harness did not run the expected review-v1 test list')
    return results


def validate_review_detailed(spec, source_bundle):
    """Return (ValidationReport, evidence) for a v2 contract; the v1 checks run first, unchanged."""
    if not is_review_spec(spec):
        raise ValueError('This validator checks review-period specifications only')
    report, evidence = core.validate_development_detailed(spec, source_bundle)
    report = copy.deepcopy(report)
    report['suiteVersion'] = SUITE_VERSION
    checks = {check['name']: check for check in report['checks']}
    entry = (evidence.get('compilation') or {}).get('entry')
    if entry and checks['compilation']['status'] == 'passed':
        try:
            problems = _interface_findings(source_bundle, entry['abi'])
        except core.ToolFailure as error:
            checks['compilation'] = core._check('compilation', 'toolError',
                                                checks['compilation']['findings'] + [core._finding('COMPILER_TOOL_ERROR', 'error', str(error))])
        else:
            if problems:
                checks['compilation'] = core._check('compilation', 'failed', checks['compilation']['findings'] + problems)
    clauses = checks['clauseTests']
    if entry and checks['compilation']['status'] == 'passed' and clauses['status'] in ('passed', 'failed'):
        try:
            results = _review_clauses(spec, entry, source_bundle)
        except core.ToolFailure as error:
            checks['clauseTests'] = core._check('clauseTests', 'toolError',
                                                clauses['findings'] + [core._finding('CLAUSE_TOOL_ERROR', 'error', str(error))])
        else:
            failed = [r for r in results if r['status'] != 'passed']
            findings = [f for f in clauses['findings'] if f['code'] != 'CLAUSE_SUMMARY']
            findings += [core._finding('CLAUSE_' + r['id'].upper().replace('-', '_'), 'error', f'{r["clause"]}: {r["message"]}')
                         for r in failed]
            v1 = next((f['message'] for f in clauses['findings'] if f['code'] == 'CLAUSE_SUMMARY'), '')
            findings.append(core._finding('CLAUSE_SUMMARY', 'info',
                                          f'{v1}; {len(results) - len(failed)}/{len(results)} {SUITE} clause tests passed'.lstrip('; ')))
            checks['clauseTests'] = core._check('clauseTests', 'failed' if failed or clauses['status'] == 'failed' else 'passed', findings)
            evidence['reviewClauseTests'] = results
    elif checks['compilation']['status'] != 'passed' and clauses['status'] != 'skipped':
        checks['clauseTests'] = core._check('clauseTests', 'skipped')
    report['checks'] = [checks['compilation'], checks['staticAnalysis'], checks['clauseTests']]
    statuses = [check['status'] for check in report['checks']]
    if 'failed' in statuses:
        report['status'], report['artifact'] = 'failed', None
    elif all(status == 'passed' for status in statuses):
        report['status'] = 'passed'   # the v1 validator already built the artifact from its own recompilation
    else:
        report['status'], report['artifact'] = 'toolError', None
    validate('ValidationReport', report)
    return report, evidence


def validate_review(spec, source_bundle):
    return validate_review_detailed(spec, source_bundle)[0]
