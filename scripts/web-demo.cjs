// Run the two loopback services together. Restart a dropped service without
// starting a model job or submitting a transaction.
const { spawn, spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');
const root = join(__dirname, '..');
const webPort = process.env.LOCAL_WEB_PORT || '5173';
const apiPort = process.env.LOCAL_API_PORT || '3001';
// `npm run demo:live` turns on the three model-backed agents (model calls may cost money).
const live = process.argv.includes('--live')
  ? { AGENT1_MODE: 'live', AGENT2_MODE: 'live', AGENT3_MODE: 'live' } : {};

function nodeVersion(executable) {
  const result = spawnSync(executable, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  const [major, minor] = (result.stdout || '').trim().split('.').map(Number);
  return result.status === 0 && Number.isInteger(major) ? { major, minor } : null;
}
const newEnough = v => v && (v.major > 22 || v.major === 22 && v.minor >= 12);
// The web interface needs Node 22.12+; the API also runs on Node 20. Look in the usual places
// so a second Node installed only for the front end is found without extra settings.
function findFrontendNode() {
  const candidates = [process.env.DEMO_FRONTEND_NODE, process.execPath,
    join(homedir(), '.accord-node', 'node_modules', '.bin', 'node'),
    '/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node',
    '/opt/homebrew/bin/node', '/usr/local/bin/node'].filter(Boolean);
  return candidates.find(candidate => newEnough(nodeVersion(candidate))) || null;
}
const frontendNode = findFrontendNode();
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
if (!frontendNode) {
  console.error('The web interface requires Node 22.12 or newer. Use Node 22.x, or set DEMO_FRONTEND_NODE to a newer Node executable.');
  process.exitCode = 1;
} else {
  if (Object.keys(live).length) console.log('Agents 1–3 use the live model (model calls may cost money).');
  console.log(`Open http://127.0.0.1:${webPort}/`);
  start({ name: 'local API', node: process.execPath, args: ['backend/server.cjs'], cwd: root,
    env: { LOCAL_API_PORT: apiPort, ...live } });
  start({ name: 'web interface', node: frontendNode,
    args: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', webPort, '--strictPort'],
    cwd: join(root, 'frontend'), env: { LOCAL_API_TARGET: `http://127.0.0.1:${apiPort}` } });
}
