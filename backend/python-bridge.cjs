// Fixed Node -> Python bridge, used by the local generation HTTP controller.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { validateResponse } = require('../shared/handoff.cjs');
const ROOT = path.resolve(__dirname, '..');
const localPython = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const active = new Set();
const LIMIT = 1024 * 1024;

function defaultTimeout(request) {
  if (request.operation === 'clarify' && process.env.AGENT1_MODE === 'live') return 60000;
  if (process.env.AGENT2_MODE !== 'live') return 10000;
  const config = request.payload?.runConfig;
  if (request.operation !== 'generate' || config?.validationMode !== 'development') return 210000;
  const repairs = Number.isInteger(config.maxRepairs) ? Math.min(5, Math.max(0, config.maxRepairs)) : 0;
  // Each attempt is one model call (at most 300 s, plus quick resends when the provider turns a
  // request away) and one validation, about 10 s; recorded runs took under 90 s in all. Seven
  // minutes per attempt keeps a stuck worker from holding the page for an hour.
  return 60000 + 420000 * (1 + repairs);
}

const PROGRESS_PREFIX = 'ACCORD_PROGRESS ';
const STAGES = new Set(['writing', 'checking', 'repairing', 'finishing']);
const CHECKS = new Set(['compilation', 'staticAnalysis', 'clauseTests']);
// A progress line from the worker, reduced to known fields; anything else is ignored.
function readProgress(line) {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const item = JSON.parse(line.slice(PROGRESS_PREFIX.length));
    if (!STAGES.has(item.stage) || !Number.isInteger(item.attempt) || item.attempt < 1 || item.attempt > 10) return null;
    const failedChecks = Array.isArray(item.failedChecks) ? item.failedChecks.filter(name => CHECKS.has(name)) : [];
    return { stage: item.stage, attempt: item.attempt, failedChecks };
  } catch { return null; }
}

function runPython(request, { timeoutMs = defaultTimeout(request), maxBytes = LIMIT, isCurrent = () => true,
  onProgress = null } = {}) {
  const key = request.payload?.spec?.projectId ?? request.payload?.projectId ?? request.payload?.draftSpec?.projectId ?? request.requestId;
  if (active.has(key)) return Promise.reject(new Error('PROJECT_BUSY'));
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > LIMIT) return Promise.reject(new Error('INPUT_LIMIT'));
  active.add(key);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || (fs.existsSync(localPython) ? localPython : 'python3'),
      ['-m', 'flows.worker'], { cwd: ROOT, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, settled = false, stopping = false, closed = false, pending = '';
    let failure, cleanupDone = false;
    const timer = setTimeout(() => stop(new Error('PYTHON_TIMEOUT')), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(key);
      error ? reject(error) : resolve(value);
    }
    function signalGroup(signal) {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    function finishCleanup() {
      // Keep the project locked until the process has actually closed.
      if (closed && cleanupDone) finish(failure);
    }
    function stop(error) {
      if (settled || stopping) return;
      stopping = true;
      failure = error;
      clearTimeout(timer);
      if (!child.pid) { cleanupDone = true; finishCleanup(); return; }
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('close', () => { cleanupDone = true; finishCleanup(); });
      } else {
        signalGroup('SIGTERM');
        // Kill the entire process group, including compiler children that ignore TERM.
        setTimeout(() => {
          signalGroup('SIGKILL');
          cleanupDone = true;
          finishCleanup();
        }, 200);
      }
    }
    child.on('error', error => stop(error));
    child.stdin.on('error', error => stop(error));
    for (const [stream, isOut] of [[child.stdout, true], [child.stderr, false]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) return stop(new Error('PYTHON_OUTPUT_LIMIT'));
        if (isOut) { stdout += chunk; return; }
        stderr += chunk;
        if (!onProgress) return;
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          const progress = readProgress(line);
          if (progress) { try { onProgress(progress); } catch { /* Progress is advisory. */ } }
        }
      });
    }
    child.on('close', code => {
      closed = true;
      if (stopping) { finishCleanup(); return; }
      if (settled) return;
      try {
        if (code !== 0) throw new Error(`PYTHON_EXIT_${code}: ${stderr.slice(0, 500)}`);
        const response = JSON.parse(stdout);
        validateResponse(request, response);
        if (response.status === 'error') throw new Error(`PYTHON_HANDOFF_ERROR: ${stderr.slice(0, 500)}`);
        if (!isCurrent(request)) throw new Error('STALE_RESULT');
        finish(null, response);
      } catch (error) { finish(error); }
    });
    child.stdin.end(input);
  });
}
module.exports = { runPython, defaultTimeout, readProgress };
