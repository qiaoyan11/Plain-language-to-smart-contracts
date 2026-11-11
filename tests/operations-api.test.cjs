// Agent 3 HTTP tests. Plans come from a controlled worker (no paid model call); receipt reports use the real Python rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../backend/server.cjs');
const { runPython } = require('../backend/python-bridge.cjs');

// A worker that answers planAction with a chosen intent and passes reportAction to real Python.
function worker(choose) {
  const seen = [];
  const runner = async (request, options) => {
    seen.push(request);
    if (request.operation !== 'planAction') return runPython(request, options);
    const { projectId, deployment } = request.payload;
    const picked = choose(request);
    const intent = picked && { projectId, chainId: deployment.chainId, contractAddress: deployment.contractAddress,
      action: picked.action, milestoneId: picked.milestoneId ?? null, ...picked.override };
    return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [],
      result: { status: intent ? 'readyForConfirmation' : 'blocked', question: null, intent, summary: 'controlled test plan' } };
  };
  return { runner, seen };
}
async function withAPI(operations, run) {
  const server = await createServer({ operations });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data) => {
    const r = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const accounts = (await call('/local-accounts')).body;
    const created = await call('/projects', { name: 'Agent 3 API', clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones: [{ title: 'Homepage', amountWei: '3000000000000000' }, { title: 'Full site', amountWei: '7000000000000000' }] });
    assert.equal(created.status, 201);
    const path = `/projects/${created.body.id}`;
    const act = (action, milestoneId) => call(path + '/actions', { action, ...(milestoneId === undefined ? {} : { milestoneId }) });
    const plan = message => call(path + '/plans', { message });
    const confirm = (planId, body = { approved: true }) => call(`${path}/plans/${planId}/confirmation`, body);
    await run({ call, path, act, plan, confirm });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('plan endpoint needs live mode, a deployed contract and a valid message', async () => {
  await withAPI({ enabled: false }, async ({ act, plan }) => {
    assert.equal((await plan('deposit')).status, 409); // not deployed
    assert.equal((await act('deploy')).status, 200);
    const off = await plan('deposit');
    assert.equal(off.status, 503);
    assert.match(off.body.error, /AGENT3_MODE=live/);
  });
  const w = worker(() => ({ action: 'deposit' }));
  await withAPI({ enabled: true, runner: w.runner }, async ({ call, path, act, plan }) => {
    await act('deploy');
    assert.equal((await plan('   ')).status, 400);
    assert.equal((await plan('x'.repeat(2001))).status, 400);
    assert.equal((await call(path + '/plans', { message: 'deposit', action: 'deposit' })).status, 400);
    assert.equal(w.seen.length, 0);
  });
});

test('deposit then acceptance: Node executes the stored intent and reports from the receipt', async () => {
  let next = { action: 'deposit' };
  const w = worker(() => next);
  await withAPI({ enabled: true, runner: w.runner }, async ({ act, plan, confirm }) => {
    await act('deploy');
    const planned = await plan('把钱存进去');
    assert.equal(planned.status, 200);
    assert.equal(planned.body.intent.action, 'deposit');
    const sent = w.seen[0].payload;
    assert.equal(sent.deployment.chainId, 31337);
    assert.equal(sent.snapshot.funded, false);
    const done = await confirm(planned.body.planId);
    assert.equal(done.status, 200);
    assert.equal(done.body.report.outcome, 'confirmed');
    assert.match(done.body.report.summary, /存款已确认/);
    assert.equal(done.body.project.funded, true);
    assert.equal((await confirm(planned.body.planId)).status, 409); // single use
    next = { action: 'acceptMilestone', milestoneId: 1 };
    const second = await plan('approve milestone 1');
    const paid = await confirm(second.body.planId);
    assert.equal(paid.body.report.outcome, 'confirmed');
    assert.match(paid.body.report.summary, /Milestone #1 "Homepage" is paid: 0\.003 ETH/);
    assert.equal(paid.body.project.milestones[0].paid, true);
    assert.equal(paid.body.project.escrowBalanceWei, '7000000000000000');
    assert.deepEqual(paid.body.project.transactions.map(t => t.action), ['deploy', 'deposit', 'acceptMilestone']);
  });
});

test('the browser cannot change, forge or reuse a plan', async () => {
  const w = worker(() => ({ action: 'deposit' }));
  await withAPI({ enabled: true, runner: w.runner }, async ({ act, plan, confirm, call, path }) => {
    await act('deploy');
    const first = await plan('deposit');
    assert.equal((await confirm(first.body.planId, { approved: true, action: 'acceptMilestone', milestoneId: 2 })).status, 400);
    assert.equal((await confirm(first.body.planId, { approved: false })).status, 400);
    assert.equal((await confirm('not-a-plan')).status, 404);
    const second = await plan('deposit again');
    assert.equal((await confirm(first.body.planId)).status, 404); // replaced by the newer plan
    assert.equal((await call(path)).body.funded, false);
    assert.equal((await confirm(second.body.planId)).body.report.outcome, 'confirmed');
  });
});

test('a plan that no longer fits the chain state sends no transaction', async () => {
  const w = worker(() => ({ action: 'acceptMilestone', milestoneId: 1 }));
  await withAPI({ enabled: true, runner: w.runner }, async ({ act, plan, confirm, call, path }) => {
    await act('deploy'); await act('deposit');
    const stale = await plan('approve 1');
    assert.equal((await act('acceptMilestone', 1)).status, 200); // paid through the buttons meanwhile
    const refused = await confirm(stale.body.planId);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /No transaction has been sent/);
    assert.equal((await call(path)).body.transactions.length, 3);
  });
});

test('Node refuses unsafe intents even if the worker returns them', async () => {
  let next = { action: 'acceptMilestone', milestoneId: 2 }; // skips milestone 1
  const w = worker(() => next);
  await withAPI({ enabled: true, runner: w.runner }, async ({ act, plan, confirm, call, path }) => {
    await act('deploy'); await act('deposit');
    const skip = await plan('pay the last one');
    assert.equal((await confirm(skip.body.planId)).status, 409);
    next = { action: 'deposit' }; // already funded
    assert.equal((await confirm((await plan('deposit')).body.planId)).status, 409);
    next = { action: 'deposit', override: { contractAddress: '0x' + '2'.repeat(40) } }; // another contract
    assert.equal((await plan('deposit elsewhere')).status, 502);
    next = { action: 'query' };
    assert.equal((await confirm((await plan('balance?')).body.planId)).status, 409);
    next = null; // blocked plan has no intent
    assert.equal((await confirm((await plan('refund me')).body.planId)).status, 409);
    assert.equal((await call(path)).body.transactions.length, 2);
  });
});

test('a failed report service never turns into a success message', async () => {
  const w = worker(() => ({ action: 'deposit' }));
  const runner = (request, options) => request.operation === 'reportAction' ? Promise.reject(new Error('PYTHON_TIMEOUT')) : w.runner(request, options);
  await withAPI({ enabled: true, runner }, async ({ act, plan, confirm }) => {
    await act('deploy');
    const done = await confirm((await plan('deposit')).body.planId);
    assert.equal(done.status, 200);
    assert.equal(done.body.report.outcome, 'unverified');
    assert.match(done.body.report.summary, /Receipt status: 1/);
    assert.equal(done.body.project.funded, true);
  });
});

test('real bridge accepts the real project snapshot (stub Agent 3, no model call)', async () => {
  const saved = process.env.AGENT3_MODE; delete process.env.AGENT3_MODE;
  try {
    await withAPI({ enabled: true }, async ({ act, plan }) => {
      await act('deploy');
      const stub = await plan('approve milestone 1');
      assert.equal(stub.status, 200);
      assert.equal(stub.body.status, 'blocked');
      assert.equal(stub.body.intent, null);
    });
  } finally { if (saved !== undefined) process.env.AGENT3_MODE = saved; }
});
