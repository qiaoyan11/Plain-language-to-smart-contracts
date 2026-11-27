// v2 review-period checks: the clause suite against the reference contract and deliberate bugs,
// then the generation path with an injected model reply and the real v2 validator (no paid calls).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const local = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.PYTHON_BIN || (fs.existsSync(local) ? local : 'python3');
const steps = [
  [process.execPath, ['--test', '--test-concurrency=4', 'tests/v2/review-escrow.test.cjs']],
  [python, ['-m', 'unittest', 'discover', '-s', 'tests/v2', '-p', 'test_*.py', '-v']],
];
for (const [command, args] of steps) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
