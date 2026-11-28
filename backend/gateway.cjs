// Public entry for a hosted Accord. Visitors first enter an access key on a cover page; after that
// the web app and its API are served through this process. Each key is its own workspace: the API
// (backend/server.cjs with hosted: true) only sees the workspace id that this gateway adds.
const http = require('node:http');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const COOKIE = 'accord_session';
const SESSION_DAYS = 30;
const DAY = 86400000;
// Requests that start a paid model call, with the default number allowed per key per UTC day.
const PAID = [
  { name: 'messages', pattern: /^\/api\/drafts\/[^/]+\/messages$/, limit: 150 },
  { name: 'generations', pattern: /^\/api\/projects\/[^/]+\/generation-runs$/, limit: 15 },
  { name: 'requests', pattern: /^\/api\/projects\/[^/]+\/plans$/, limit: 150 },
];

/** Access keys from "key1, label2=key2" (commas or new lines). Keys shorter than 12 characters are refused. */
function readKeys(text = '') {
  const keys = new Map();
  for (const entry of text.split(/[\n,]/).map(item => item.trim()).filter(Boolean)) {
    const split = entry.indexOf('=');
    const key = split > 0 ? entry.slice(split + 1).trim() : entry;
    if (key.length < 12) throw new Error('Each access key needs at least 12 characters.');
    keys.set(workspaceOf(key), split > 0 ? entry.slice(0, split).trim() : 'key');
  }
  return keys;
}
/** The workspace a key opens: stable across restarts, and not the key itself. */
function workspaceOf(key) {
  return createHash('sha256').update('accord-workspace-v1:' + key).digest('hex').slice(0, 32);
}

function coverPage({ error = '', next = '/' } = {}) {
  const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accord · Enter your access key</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root { color-scheme: light; --bg: #f7f7f5; --card: #fff; --text: #1f2a24; --muted: #5d6762; --primary: #2f6b55; --border: #dcdfdc; --danger: #b42318; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text);
  font: 15px/1.6 "DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 32px; }
.brand { font-weight: 600; font-size: 18px; }
.badge { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; padding: 2px 9px; border: 1px solid var(--border);
  border-radius: 999px; font-size: 12px; font-weight: 400; color: var(--muted); vertical-align: 2px; }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #e0a419; }
h1 { margin: 24px 0 6px; font-size: 24px; font-weight: 500; line-height: 1.3; }
p { margin: 0 0 20px; color: var(--muted); }
label { display: block; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
input { width: 100%; padding: 11px 12px; border: 1px solid var(--border); border-radius: 6px; font: inherit; color: var(--text); background: var(--card); }
input:focus { outline: 2px solid color-mix(in srgb, var(--primary) 30%, transparent); border-color: var(--primary); }
button { width: 100%; margin-top: 16px; padding: 11px 16px; border: 0; border-radius: 6px; background: var(--primary); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.error { margin: 12px 0 0; color: var(--danger); font-size: 14px; }
.note { margin: 20px 0 0; font-size: 12px; }
</style></head>
<body><main>
<div class="brand">Accord<span class="badge">Test network</span></div>
<h1>Enter your access key</h1>
<p>Accord turns a plain-language agreement into milestone escrow payments. Access is by invitation.</p>
<form method="post" action="/access">
<label for="key">Access key</label>
<input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${escape(next)}">
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
<button type="submit">Continue</button>
</form>
<p class="note">Payments use test ETH on a test network; no real money moves. What you type or upload is sent to an AI model (OpenAI) and kept on this server, so leave out personal details you do not want stored.</p>
</main></body></html>`;
}

function createGateway({ keys, secret = randomBytes(32), api, web, limits = {}, clock = true,
  now = () => Date.now() } = {}) {
  if (!(keys instanceof Map) || !keys.size) throw new Error('Configure at least one access key (ACCORD_ACCESS_KEYS).');
  const allowed = Object.fromEntries(PAID.map(p => [p.name, limits[p.name] ?? p.limit]));
  const usage = new Map(); // `${day}:${workspace}:${name}` -> count
  const failures = new Map(); // address -> { count, until }

  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  function session(req) {
    const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='));
    const [workspace, expires, mac] = (cookie?.slice(COOKIE.length + 1) || '').split('.');
    if (!workspace || !expires || !mac || !keys.has(workspace) || Number(expires) < now()) return null;
    const expected = Buffer.from(sign(`${workspace}.${expires}`)), given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given) ? workspace : null;
  }
  const secure = req => req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  function setSession(req, res, workspace) {
    const expires = now() + SESSION_DAYS * DAY;
    res.setHeader('Set-Cookie', `${COOKIE}=${workspace}.${expires}.${sign(`${workspace}.${expires}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`);
  }
  const address = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const safeNext = value => (typeof value === 'string' && /^\/(?!\/)[^\s]*$/.test(value) && !value.startsWith('/access') ? value : '/');
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY' };
  function page(res, status, html) {
    res.writeHead(status, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  function json(res, status, data) {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
  function readForm(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; if (data.length > 4096) { reject(new Error('too large')); req.destroy(); } });
      req.on('end', () => resolve(new URLSearchParams(data)));
      req.on('error', reject);
    });
  }
  // The browser's own origin must send state-changing API calls (the cookie alone is not enough).
  function sameOrigin(req) {
    const origin = req.headers.origin || req.headers.referer;
    if (!origin) return false;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  function proxy(req, res, target, extra = {}) {
    const forwarded = { ...req.headers, host: `${target.host}:${target.port}`, ...extra };
    for (const name of ['cookie', 'origin', 'referer', 'x-accord-owner']) if (!(name in extra)) delete forwarded[name];
    const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers: forwarded },
      reply => {
        const { 'set-cookie': _ignored, ...rest } = reply.headers;
        res.writeHead(reply.statusCode, { ...rest, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
        reply.pipe(res);
      });
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      if (req.url.startsWith('/api/')) json(res, 502, { error: 'The server is restarting. Try again in a moment.' });
      else page(res, 502, '<p>Accord is restarting. Reload this page in a moment.</p>');
    });
    req.pipe(upstream);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/favicon.svg') return proxy(req, res, web);
    if (url.pathname === '/access') {
      if (req.method === 'GET') {
        if (session(req)) { res.writeHead(303, { ...headers, Location: safeNext(url.searchParams.get('next')) }); return res.end(); }
        return page(res, 200, coverPage({ next: safeNext(url.searchParams.get('next')) }));
      }
      if (req.method !== 'POST') return page(res, 405, coverPage());
      const who = address(req), block = failures.get(who);
      if (block && block.count >= 10 && block.until > now())
        return page(res, 429, coverPage({ error: 'Too many attempts. Try again in 15 minutes.' }));
      let form;
      try { form = await readForm(req); } catch { return page(res, 400, coverPage()); }
      const next = safeNext(form.get('next'));
      const workspace = workspaceOf(String(form.get('key') || '').trim());
      if (!keys.has(workspace)) {
        const count = block && block.until > now() ? block.count + 1 : 1;
        failures.set(who, { count, until: now() + 15 * 60000 });
        return page(res, 401, coverPage({ error: 'That access key is not valid.', next }));
      }
      failures.delete(who);
      setSession(req, res, workspace);
      res.writeHead(303, { ...headers, Location: next });
      return res.end();
    }
    if (url.pathname === '/access/sign-out' && req.method === 'POST') {
      res.writeHead(303, { ...headers, Location: '/access',
        'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}` });
      return res.end();
    }
    const workspace = session(req);
    const isApi = url.pathname.startsWith('/api/');
    if (!workspace) {
      if (isApi) return json(res, 401, { error: 'Enter your access key to continue.' });
      res.writeHead(303, { ...headers, Location: `/access?next=${encodeURIComponent(url.pathname + url.search)}` });
      return res.end();
    }
    if (!isApi) return proxy(req, res, web);
    // Lets the page offer "Sign out"; a local run has no such endpoint.
    if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { signedIn: true, label: keys.get(workspace) });
    if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'This request must come from the Accord page.' });
    if (!clock && /^\/api\/projects\/[^/]+\/clock$/.test(url.pathname))
      return json(res, 403, { error: 'Skipping ahead is turned off on this site.' });
    if (req.method === 'POST') {
      const paid = PAID.find(p => p.pattern.test(url.pathname));
      if (paid) {
        const key = `${new Date(now()).toISOString().slice(0, 10)}:${workspace}:${paid.name}`;
        const used = usage.get(key) ?? 0;
        if (used >= allowed[paid.name])
          return json(res, 429, { error: 'This access key has reached today\'s limit for AI requests. Try again tomorrow.' });
        usage.set(key, used + 1);
        if (usage.size > 5000) for (const old of usage.keys()) if (!old.startsWith(key.slice(0, 10))) usage.delete(old);
      }
    }
    return proxy(req, res, api, { 'x-accord-owner': workspace });
  });
}

module.exports = { createGateway, readKeys, workspaceOf, coverPage };
