// Standalone adapter only: server.cjs does not expose this to the UI yet.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');
const localPython = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const active = new Set();
const LIMIT = 1024 * 1024;

function runPython(request, { timeoutMs = 10000, maxBytes = LIMIT, isCurrent = () => true } = {}) {
  const key = request.payload?.spec?.projectId ?? request.payload?.projectId ?? request.payload?.draftSpec?.projectId ?? request.requestId;
  if (active.has(key)) return Promise.reject(new Error('PROJECT_BUSY'));
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > LIMIT) return Promise.reject(new Error('INPUT_LIMIT'));
  active.add(key);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || (fs.existsSync(localPython) ? localPython : 'python3'),
      ['-m', 'flows.worker'], { cwd: ROOT, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, settled = false;
    const timer = setTimeout(() => finish(new Error('PYTHON_TIMEOUT')), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      active.delete(key);
      error ? reject(error) : resolve(value);
    }
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    for (const [stream, isOut] of [[child.stdout, true], [child.stderr, false]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) return finish(new Error('PYTHON_OUTPUT_LIMIT'));
        if (isOut) stdout += chunk; else stderr += chunk;
      });
    }
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw new Error(`PYTHON_EXIT_${code}: ${stderr.slice(0, 500)}`);
        const response = JSON.parse(stdout);
        if (response.interfaceVersion !== 1 || response.requestId !== request.requestId ||
            !['ok', 'error'].includes(response.status) || !Array.isArray(response.errors)) throw new Error('INVALID_ENVELOPE');
        if (response.status === 'error') throw new Error(`PYTHON_HANDOFF_ERROR: ${stderr.slice(0, 500)}`);
        if (response.errors.length || !response.result) throw new Error('INVALID_RESULT');
        const spec = request.payload?.spec;
        const bundle = response.result.sourceBundle;
        if (spec && bundle && (bundle.projectId !== spec.projectId || bundle.specVersion !== spec.specVersion)) throw new Error('STALE_RESULT');
        if (!isCurrent(request)) throw new Error('STALE_RESULT');
        finish(null, response);
      } catch (error) { finish(error); }
    });
    child.stdin.end(input);
  });
}
module.exports = { runPython };
