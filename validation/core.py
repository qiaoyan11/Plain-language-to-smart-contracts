"""Independent development validation for generated IMilestoneEscrow v1 contracts.

validate_development(spec, source_bundle) -> ValidationReport (shared/INTERFACES.md section 6).
Every verdict comes from tools run here: solc-js recompilation, Slither, and Hardhat clause tests.
Nothing in the bundle except its source files is trusted; Agent 2's own compilation output is ignored.
"""
import copy
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from shared.handoff import ROOT, source_hash, validate

SOLC_VERSION = '0.8.28'
SLITHER_VERSION = '0.11.3'
CLAUSE_SUITE = 'clause-v1'
STATIC_POLICY = 'slither-block-high-medium-v1'
BLOCKING_IMPACTS = ('High', 'Medium')
SUITE_VERSION = f'dev-v1;solc-js-{SOLC_VERSION};{CLAUSE_SUITE};slither-{SLITHER_VERSION};{STATIC_POLICY}'
CONSTRUCTOR_TYPES = ['address', 'address', 'uint256[]']
EXPECTED_CLAUSES = [
    'flow-1', 'flow-2', 'flow-3', 'flow-5', 'flow-spec', 'access-deposit', 'access-accept',
    'deposit-exact', 'deposit-once', 'unfunded-accept', 'unfunded-forced-eth', 'order-skip',
    'order-repeat', 'recipient-reject-rollback', 'recipient-reentry', 'constructor-0', 'constructor-6',
    'constructor-zero-first', 'constructor-zero-later', 'constructor-zero-client',
    'constructor-zero-provider', 'constructor-same-parties', 'id-out-of-range']
NODE_DIR = Path(__file__).resolve().parent / 'node'
INTERFACE_FILE = ROOT / 'contracts/IMilestoneEscrow.sol'


class ToolFailure(Exception):
    """A validation tool is missing, crashed, timed out or produced unusable output."""


def _finding(code, severity, message, file=None, line=None):
    return {'code': code, 'severity': severity, 'message': message[:2000] or code,
            'file': file or None, 'line': line if isinstance(line, int) and line >= 1 else None}


def _check(name, status, findings=()):
    return {'name': name, 'status': status, 'findings': list(findings)}


def _env(extra=None):
    keep = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR')
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(extra or {})
    return env


def _run_node(script, payload, timeout):
    node = shutil.which('node')
    if not node:
        raise ToolFailure('node executable not found on PATH')
    try:
        proc = subprocess.run([node, '--max-old-space-size=512', str(NODE_DIR / script)], input=json.dumps(payload),
                              capture_output=True, text=True, cwd=ROOT, timeout=timeout, env=_env())
    except subprocess.TimeoutExpired:
        raise ToolFailure(f'{script} timed out after {timeout} s')
    except OSError as e:
        raise ToolFailure(f'{script} could not start: {e}')
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    try:
        out = json.loads(lines[-1])
    except (IndexError, ValueError):
        raise ToolFailure(f'{script} returned no JSON (exit {proc.returncode}): {proc.stderr[-500:]}')
    if out.get('toolError'):
        raise ToolFailure(out['toolError'])
    return out


# ---------------------------------------------------------------- compilation

def _compile(bundle):
    out = _run_node('compile.cjs', {'bundle': bundle, 'interfaceSource': INTERFACE_FILE.read_text()}, timeout=120)
    findings = [_finding(d['code'], d['severity'], d['message'], d.get('file'), d.get('line')) for d in out['diagnostics']]
    failed = any(d['severity'] == 'error' for d in out['diagnostics']) or out['entry'] is None
    return _check('compilation', 'failed' if failed else 'passed', findings), (None if failed else out), out


# ------------------------------------------------------------ static analysis

def _find_slither(explicit):
    if explicit:  # an explicit path is used as-is, with no fallback
        return explicit if Path(explicit).is_file() and os.access(explicit, os.X_OK) else None
    for candidate in (os.environ.get('VALIDATION_SLITHER'),
                      str(Path(sys.executable).parent / 'slither'), shutil.which('slither')):
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _static(bundle, slither_path):
    slither = _find_slither(slither_path)
    if not slither:
        raise ToolFailure('slither executable not found (pip install -r validation/requirements.txt)')
    try:
        version = subprocess.run([slither, '--version'], capture_output=True, text=True, timeout=60, env=_env()).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ToolFailure(f'slither --version failed: {e}')
    if version != SLITHER_VERSION:
        raise ToolFailure(f'slither {version or "unknown"} installed; suite {SUITE_VERSION} requires {SLITHER_VERSION}')
    node = shutil.which('node')
    if not node:
        raise ToolFailure('node executable not found on PATH')
    with tempfile.TemporaryDirectory(prefix='validation-slither-') as work:
        work = Path(work)
        for name, text in bundle['sources'].items():
            target = work / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding='utf-8')
        wrapper = work.parent / (work.name + '-solc')
        wrapper.write_text(f'#!/bin/sh\nexec "{node}" "{NODE_DIR / "solc-shim.cjs"}" "$@"\n')
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
        try:
            proc = subprocess.run([slither, bundle['entryFile'], '--solc', str(wrapper), '--json', '-',
                                   '--json-types', 'detectors,compilations', '--disable-color'],
                                  capture_output=True, text=True, cwd=work, timeout=240,
                                  env=_env({'SOLC_JS_PATH': str(ROOT / 'node_modules/solc'),
                                            'SOLC_SHIM_SETTINGS': json.dumps(bundle['buildSettings'])}))
        except subprocess.TimeoutExpired:
            raise ToolFailure('slither timed out')
        finally:
            wrapper.unlink(missing_ok=True)
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        raise ToolFailure(f'slither returned no JSON (exit {proc.returncode}): {proc.stderr[-500:]}')
    if not data.get('success'):
        raise ToolFailure(f'slither failed: {str(data.get("error"))[:500]}')
    analysed = set()
    for comp in data['results'].get('compilations', []):
        for unit in comp.get('compilation_units', {}).values():
            for su in unit.get('source_units', {}).values():
                analysed.update(su.get('ast', {}).get('exportedSymbols', {}).keys())
    if bundle['entryContract'] not in analysed:
        raise ToolFailure(f'slither did not analyse entry contract {bundle["entryContract"]}')
    raw, findings = [], []
    for d in data['results'].get('detectors', []):
        blocking = d['impact'] in BLOCKING_IMPACTS
        loc = next((e.get('source_mapping') for e in d.get('elements', []) if e.get('source_mapping')), {}) or {}
        first_line = (d.get('description') or d['check']).strip().splitlines()[0]
        raw.append({'check': d['check'], 'impact': d['impact'], 'confidence': d['confidence'], 'blocking': blocking,
                    'description': d.get('description', '').strip(), 'file': loc.get('filename_relative'),
                    'lines': loc.get('lines', [])})
        findings.append(_finding('SLITHER_' + d['check'], d['impact'].lower(),
                                 f'[{"blocking" if blocking else "non-blocking"}; confidence {d["confidence"]}] {first_line}',
                                 loc.get('filename_relative'), (loc.get('lines') or [None])[0]))
    blocking_count = sum(r['blocking'] for r in raw)
    findings.append(_finding('STATIC_SUMMARY', 'info',
                             f'Slither {SLITHER_VERSION}: {len(raw)} finding(s), {blocking_count} blocking under {STATIC_POLICY} '
                             f'(blocks impact {"/".join(BLOCKING_IMPACTS)})'))
    return _check('staticAnalysis', 'failed' if blocking_count else 'passed', findings), {'slither': SLITHER_VERSION, 'detectors': raw}


# --------------------------------------------------------------- clause tests

def _clauses(spec, compiled, bundle):
    out = _run_node('clause-tests.cjs', {'abi': compiled['entry']['abi'], 'bytecode': compiled['entry']['bytecode'],
                                         'specAmounts': [m['amountWei'] for m in spec['milestones']],
                                         'buildSettings': bundle['buildSettings']}, timeout=240)
    results = out['results']
    if out.get('suite') != CLAUSE_SUITE or [r['id'] for r in results] != EXPECTED_CLAUSES:
        raise ToolFailure('clause harness did not run the expected clause-v1 test list')
    failed = [r for r in results if r['status'] != 'passed']
    findings = [_finding('CLAUSE_' + r['id'].upper().replace('-', '_'), 'error', f'{r["clause"]}: {r["message"]}') for r in failed]
    findings += [_finding(w['code'], 'warning', w['message']) for w in out.get('warnings', [])]
    findings.append(_finding('CLAUSE_SUMMARY', 'info', f'{len(results) - len(failed)}/{len(results)} {CLAUSE_SUITE} clause tests passed'))
    return _check('clauseTests', 'failed' if failed else 'passed', findings), out


# ---------------------------------------------------------------- entry point

def validate_development(spec, source_bundle):
    """Return a schema-valid ValidationReport for one SourceBundle."""
    return validate_development_detailed(spec, source_bundle)[0]


def validate_development_detailed(spec, source_bundle, *, static_analysis=True, slither_path=None):
    """Return (ValidationReport, evidence). static_analysis=False is a test-only switch; it can never pass."""
    started = time.time()
    validate('ConfirmedSpec', spec)  # trusted Node data; an invalid spec is a caller error
    bundle = copy.deepcopy(source_bundle)
    declared = bundle.get('sourceHash')
    report = {'reportId': 'val-' + uuid.uuid4().hex, 'projectId': bundle.get('projectId'), 'specVersion': bundle.get('specVersion'),
              'sourceHash': declared, 'suiteVersion': SUITE_VERSION, 'mode': 'development', 'status': 'failed',
              'checks': [], 'artifact': None}
    evidence = {'reportId': report['reportId'], 'suiteVersion': SUITE_VERSION, 'declaredSourceHash': declared,
                'recomputedSourceHash': None, 'tools': {'node': shutil.which('node'), 'solcJs': SOLC_VERSION,
                                                        'slither': SLITHER_VERSION, 'python': sys.version.split()[0]}}
    checks = {}
    skipped = lambda name: _check(name, 'skipped')

    # Input integrity: recompute the hash; never trust the declared one.
    problem = None
    try:
        recomputed = source_hash(bundle)
        evidence['recomputedSourceHash'] = recomputed
        validate('SourceBundle', {**bundle, 'sourceHash': recomputed})
        if declared != recomputed:
            problem = _finding('SOURCE_HASH_MISMATCH', 'error', f'Declared {declared} but recomputed {recomputed}')
        elif (bundle['projectId'], bundle['specVersion']) != (spec['projectId'], spec['specVersion']):
            problem = _finding('STALE_SOURCE_BUNDLE', 'error', 'Bundle projectId/specVersion does not match the confirmed spec')
    except Exception as e:  # KeyError/TypeError for malformed input, ValueError/ValidationError from shared.handoff
        problem = _finding('INVALID_SOURCE_BUNDLE', 'error', f'Source bundle rejected before compilation: {str(e)[:300]}')
    if problem:
        checks = {'compilation': _check('compilation', 'failed', [problem]),
                  'staticAnalysis': skipped('staticAnalysis'), 'clauseTests': skipped('clauseTests')}
    else:
        try:
            checks['compilation'], compiled, evidence['compilation'] = _compile(bundle)
        except ToolFailure as e:
            checks['compilation'], compiled = _check('compilation', 'toolError', [_finding('COMPILER_TOOL_ERROR', 'error', str(e))]), None
        if compiled is None:
            checks['staticAnalysis'], checks['clauseTests'] = skipped('staticAnalysis'), skipped('clauseTests')
        else:
            if static_analysis:
                try:
                    checks['staticAnalysis'], evidence['staticAnalysis'] = _static(bundle, slither_path)
                except ToolFailure as e:
                    checks['staticAnalysis'] = _check('staticAnalysis', 'toolError', [_finding('STATIC_TOOL_ERROR', 'error', str(e))])
            else:
                checks['staticAnalysis'] = skipped('staticAnalysis')
            try:
                checks['clauseTests'], evidence['clauseTests'] = _clauses(spec, compiled, bundle)
            except ToolFailure as e:
                checks['clauseTests'] = _check('clauseTests', 'toolError', [_finding('CLAUSE_TOOL_ERROR', 'error', str(e))])

    report['checks'] = [checks['compilation'], checks['staticAnalysis'], checks['clauseTests']]
    statuses = [c['status'] for c in report['checks']]
    if 'failed' in statuses:
        report['status'] = 'failed'
    elif all(s == 'passed' for s in statuses):
        report['status'] = 'passed'
        report['artifact'] = {'abi': compiled['entry']['abi'], 'bytecode': compiled['entry']['bytecode'],
                              'compilerVersion': bundle['compilerVersion'], 'buildSettings': bundle['buildSettings'],
                              'sourceHash': declared, 'constructorTypes': CONSTRUCTOR_TYPES}
    else:
        report['status'] = 'toolError'  # a tool error or skipped check means "cannot judge", never a pass
    validate('ValidationReport', report)  # raises only if the bundle cannot even be identified (projectId/hash)
    evidence['seconds'] = round(time.time() - started, 2)
    return report, evidence
