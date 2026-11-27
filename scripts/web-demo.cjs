// Run the two loopback services together. Restart a dropped service without
// starting a model job or submitting a transaction.
const { spawn, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const root = join(__dirname, '..');
const webPort = process.env.LOCAL_WEB_PORT || '5173';
const apiPort = process.env.LOCAL_API_PORT || '3001';
const frontendNode = process.env.DEMO_FRONTEND_NODE || process.execPath;
const running = new Set(), timers = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const timer of timers) clearTimeout(timer);
  for (const child of running) child.kill('SIGTERM');
}
function start(service, failures = 0) {
  const began = Date.now();
  const child = spawn(service.node, service.args, {
    cwd: service.cwd, env: { ...process.env, ...service.env }, stdio: 'inherit',
  });
  running.add(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', () => {
    running.delete(child);
    if (stopping) return;
    const next = Date.now() - began > 30000 ? 1 : failures + 1;
    if (next > 3) {
      console.error(`${service.name} could not start. Check the port and the error above. Your saved projects remain on disk.`);
      stop(1);
      return;
    }
    console.warn(`Reconnecting ${service.name}…`);
    const timer = setTimeout(() => { timers.delete(timer); start(service, next); }, 1000 * next);
    timers.add(timer);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
const version = spawnSync(frontendNode, ['-p', 'process.versions.node'], { encoding: 'utf8' });
const [major, minor] = (version.stdout || '').trim().split('.').map(Number);
if (version.status !== 0 || !Number.isInteger(major) || major < 22 || major === 22 && minor < 12) {
  console.error('The web interface requires Node 22.12 or newer. Use Node 22.x, or set DEMO_FRONTEND_NODE to a newer Node executable.');
  process.exitCode = 1;
} else {
  start({ name: 'local API', node: process.execPath, args: ['backend/server.cjs'], cwd: root,
    env: { LOCAL_API_PORT: apiPort } });
  start({ name: 'web interface', node: frontendNode,
    args: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', webPort, '--strictPort'],
    cwd: join(root, 'frontend'), env: { LOCAL_API_TARGET: `http://127.0.0.1:${apiPort}` } });
}
