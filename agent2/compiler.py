"""Fixed local compiler invocation, without API credentials in its environment."""
import json
import os
import subprocess
from shared.handoff import ROOT


def compile_bundle(request, response):
    env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP') if k in os.environ}
    try:
        process = subprocess.run(['node', '--max-old-space-size=256', str(ROOT / 'scripts/compile-generated.cjs')],
                                 input=json.dumps({'request': request, 'response': response}),
                                 capture_output=True, text=True, cwd=ROOT, timeout=30, env=env)
        if len(process.stdout.encode()) > 2 * 1024 * 1024:
            raise ValueError('Output too large')
        report = json.loads(process.stdout)
        if process.returncode or report.get('status') not in ('passed', 'failed'):
            raise ValueError('Compiler tool failure')
        return report
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {'status': 'toolError', 'scope': 'compilation-only', 'artifact': None,
                'diagnostics': [{'severity': 'error', 'code': 'COMPILER_TOOL_ERROR',
                                 'message': 'Compiler unavailable, timed out, or returned invalid output.'}]}
