// Hosted Accord in one process tree: the API (hosted workspaces, live agents), the built web app,
// and the public gateway with the access-key cover page. See docs/DEPLOY.md.
//   ACCORD_ACCESS_KEYS   required: "key" or "label=key", separated by commas
//   ACCORD_SESSION_SECRET  keeps sign-ins valid across restarts (random if unset)
//   ACCORD_DATA_DIR      where projects, drafts, chain history and run records are kept
//   PORT                 public port (default 8080)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createGateway, readKeys } = require('../backend/gateway.cjs');
const root = path.join(__dirname, '..');
const port = Number(process.env.PORT || 8080);
const api = { host: '127.0.0.1', port: Number(process.env.ACCORD_API_PORT || 3001) };
const web = { host: '127.0.0.1', port: Number(process.env.ACCORD_WEB_PORT || 3000) };
const dataDir = process.env.ACCORD_DATA_DIR ? path.resolve(process.env.ACCORD_DATA_DIR) : null;
const stateDir = dataDir ? path.join(dataDir, 'state') : path.join(root, 'data/private/hosted-state');

// Keep everything that must survive a redeploy on the data volume.
function onVolume(relative) {
  const inside = path.join(root, relative), target = path.join(dataDir, relative.replace(/[\\/]/g, '-'));
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (path.resolve(inside) === path.resolve(target)) return;
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  if (fs.existsSync(inside) && !fs.lstatSync(inside).isSymbolicLink()) {
    if (fs.readdirSync(inside).length) throw new Error(`${inside} has files; move them to ${target} first.`);
    fs.rmdirSync(inside);
  }
  if (!fs.existsSync(inside)) fs.symlinkSync(target, inside);
}
if (dataDir) { onVolume('data/private'); onVolume('artifacts'); }

const keys = readKeys(process.env.ACCORD_ACCESS_KEYS || '');
const secret = process.env.ACCORD_SESSION_SECRET || undefined;
const limit = name => (process.env[`ACCORD_LIMIT_${name.toUpperCase()}`] ? Number(process.env[`ACCORD_LIMIT_${name.toUpperCase()}`]) : undefined);
const gateway = createGateway({ keys, secret, api, web,
  limits: { messages: limit('messages'), generations: limit('generations'), requests: limit('requests') },
  clock: process.env.ACCORD_TEST_CLOCK !== 'off' });

const running = new Set();
let stopping = false;
function start(name, args, env, failures = 0) {
  const began = Date.now();
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  running.add(child);
  child.on('exit', code => {
    running.delete(child);
    if (stopping) return;
    const next = Date.now() - began > 60000 ? 1 : failures + 1;
    if (next > 5) { console.error(`${name} keeps stopping (exit ${code}); shutting down.`); return stop(1); }
    console.warn(`${name} stopped (exit ${code}); restarting.`);
    setTimeout(() => start(name, args, env, next), 1000 * next);
  });
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  gateway.close();
  for (const child of running) child.kill('SIGTERM');
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

start('API', ['backend/server.cjs'], { ACCORD_HOSTED: '1', LOCAL_API_PORT: String(api.port),
  LOCAL_STATE_DIR: stateDir, AGENT1_MODE: 'live', AGENT2_MODE: 'live', AGENT3_MODE: 'live' });
start('web app', ['frontend/.output/server/index.mjs'], { PORT: String(web.port), HOST: web.host, NITRO_HOST: web.host,
  NITRO_PORT: String(web.port) });
gateway.listen(port, '0.0.0.0', () => console.log(`Accord is listening on port ${port} (${keys.size} access key${keys.size === 1 ? '' : 's'}).`));
