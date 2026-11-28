// Hosted site: the access-key gateway and per-key workspaces. No models, chain transactions or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway, readKeys, workspaceOf } = require('../backend/gateway.cjs');
const { createServer } = require('../backend/server.cjs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); };

async function withGateway(options, run) {
  const seen = [];
  const api = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => { seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'leak=1' }); res.end('{"ok":true}'); });
  });
  const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>app</title>'); });
  const [apiPort, webPort] = [await listen(api), await listen(web)];
  let clock = Date.parse('2026-11-28T10:00:00Z');
  const gateway = createGateway({ keys: readKeys('alice=alice-key-123456, bob-key-1234567'), secret: 'test-secret',
    api: { host: '127.0.0.1', port: apiPort }, web: { host: '127.0.0.1', port: webPort }, now: () => clock, ...options });
  const port = await listen(gateway), base = `http://127.0.0.1:${port}`;
  const call = (path, { cookie, method = 'GET', body, origin = base, type = 'application/json', headers = {} } = {}) =>
    fetch(base + path, { method, redirect: 'manual', body, headers: { ...(cookie ? { cookie } : {}),
      ...(origin && method !== 'GET' ? { origin } : {}), ...(body ? { 'content-type': type } : {}), ...headers } });
  const signIn = async key => {
    const response = await call('/access', { method: 'POST', type: 'application/x-www-form-urlencoded', body: `key=${key}&next=/projects` });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try { await run({ call, signIn, seen, advance: ms => { clock += ms; } }); }
  finally { await Promise.all([close(gateway), close(api), close(web)]); }
}

test('keys are read with optional labels and must be long enough', () => {
  const keys = readKeys('team=alice-key-123456\nbob-key-1234567');
  assert.equal(keys.size, 2);
  assert.equal(keys.get(workspaceOf('alice-key-123456')), 'team');
  assert.throws(() => readKeys('short'), /at least 12/);
  assert.throws(() => createGateway({ keys: new Map() }), /at least one access key/);
});

test('nothing is served before a valid key, and the cover page cannot redirect elsewhere', async () => {
  await withGateway({}, async ({ call, signIn, seen }) => {
    const page = await call('/projects/abc');
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/access?next=%2Fprojects%2Fabc');
    assert.equal((await call('/api/projects')).status, 401);
    assert.match(await (await call('/access')).text(), /Enter your access key/);
    const wrong = await signIn('not-the-key-0000');
    assert.equal(wrong.response.status, 401);
    assert.match(await wrong.response.text(), /not valid/);
    const evil = await call('/access', { method: 'POST', type: 'application/x-www-form-urlencoded', body: 'key=alice-key-123456&next=//evil.example' });
    assert.equal(evil.headers.get('location'), '/');
    const { response, cookie } = await signIn('alice-key-123456');
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/projects');
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.equal(await (await call('/projects', { cookie })).text(), '<title>app</title>');
    assert.equal((await call('/api/projects', { cookie: cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) })).status, 401);
    assert.equal(seen.length, 0);
  });
});

test('the API gets the workspace from the gateway only, and state changes need the page origin', async () => {
  await withGateway({}, async ({ call, signIn, seen }) => {
    const alice = (await signIn('alice-key-123456')).cookie, bob = (await signIn('bob-key-1234567')).cookie;
    const response = await call('/api/projects', { cookie: alice, headers: { 'x-accord-owner': 'f'.repeat(32) } });
    assert.equal(response.headers.get('set-cookie'), null);
    await call('/api/projects', { cookie: bob });
    assert.equal(seen[0].headers['x-accord-owner'], workspaceOf('alice-key-123456'));
    assert.equal(seen[1].headers['x-accord-owner'], workspaceOf('bob-key-1234567'));
    assert.equal(seen[0].headers.cookie, undefined);
    assert.deepEqual(await (await call('/api/session', { cookie: alice })).json(), { signedIn: true, label: 'alice' });
    assert.equal((await call('/api/drafts', { cookie: alice, method: 'POST', body: '{}', origin: null })).status, 403);
    assert.equal((await call('/api/drafts', { cookie: alice, method: 'POST', body: '{}', origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/api/drafts', { cookie: alice, method: 'POST', body: '{}' })).status, 200);
  });
});

test('paid requests have a daily limit per key; skipping ahead can be turned off', async () => {
  await withGateway({ limits: { generations: 2 }, clock: false }, async ({ call, signIn, advance }) => {
    const alice = (await signIn('alice-key-123456')).cookie, bob = (await signIn('bob-key-1234567')).cookie;
    const generate = cookie => call('/api/projects/p1/generation-runs', { cookie, method: 'POST', body: '{}' });
    assert.deepEqual([(await generate(alice)).status, (await generate(alice)).status, (await generate(alice)).status], [200, 200, 429]);
    assert.equal((await generate(bob)).status, 200);
    assert.equal((await call('/api/projects/p1/generation-runs/r1/deployment', { cookie: alice, method: 'POST', body: '{}' })).status, 200);
    advance(24 * 3600 * 1000);
    assert.equal((await generate(alice)).status, 200);
    assert.equal((await call('/api/projects/p1/clock', { cookie: alice, method: 'POST', body: '{}' })).status, 403);
  });
});

test('repeated wrong keys are slowed down', async () => {
  await withGateway({}, async ({ signIn, advance }) => {
    for (let i = 0; i < 10; i++) assert.equal((await signIn('wrong-key-0000' + i)).response.status, 401);
    assert.equal((await signIn('alice-key-123456')).response.status, 429);
    advance(16 * 60000);
    assert.equal((await signIn('alice-key-123456')).response.status, 303);
  });
});

test('a hosted API keeps each workspace to itself', async () => {
  const server = await createServer({ hosted: true, generation: { enabled: false }, operations: { enabled: false },
    drafting: { enabled: false } });
  const port = await listen(server), base = `http://127.0.0.1:${port}/api`;
  const [a, b] = ['a'.repeat(32), 'b'.repeat(32)];
  const call = (path, owner, body) => fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { ...(owner ? { 'x-accord-owner': owner } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  try {
    assert.equal((await call('/projects')).status, 401);
    const accounts = (await call('/local-accounts', a)).body;
    const created = await call('/projects', a, { name: 'Logo', clientWallet: accounts.clientWallet,
      developerWallet: accounts.developerWallet, milestones: [{ title: 'Files', amountWei: '1000' }] });
    assert.equal(created.status, 201);
    assert.equal('owner' in created.body, false);
    assert.equal((await call('/projects', a)).body.projects.length, 1);
    assert.equal((await call('/projects', b)).body.projects.length, 0);
    assert.equal((await call(`/projects/${created.body.id}`, b)).status, 404);
    assert.equal((await call(`/projects/${created.body.id}`, a)).status, 200);
    const draft = await call('/drafts', a, {});
    assert.equal('owner' in draft.body, false);
    assert.equal((await call(`/drafts/${draft.body.id}`, b)).status, 404);
    assert.equal((await call(`/drafts/${draft.body.id}/discard`, b, {})).status, 404);
    assert.equal((await call(`/drafts/${draft.body.id}`, a)).status, 200);
  } finally { await close(server); }
});

test('a lease left by a writer that is gone does not block a restarted container', { skip: process.platform !== 'linux' }, () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { openStateStore } = require('../backend/state-store.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accord-lease-'));
  // After a restart the same small process id belongs to a different, later process.
  fs.writeFileSync(path.join(directory, `writer-${process.pid}-s1-00000000-0000-0000-0000-000000000000.lock`), '');
  const store = openStateStore(directory);
  assert.deepEqual(fs.readdirSync(directory).filter(n => n.endsWith('.lock')).length, 1);
  assert.throws(() => openStateStore(directory), /Another backend/);
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
