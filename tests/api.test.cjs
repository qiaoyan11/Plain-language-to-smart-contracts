const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../backend/server.cjs');
async function withAPI(run) {
  const server = await createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data) => {
    const r = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  try { await run(call, base); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
for (const count of [1, 2, 3, 5]) {
  test(`HTTP API: ${count} custom stages, exact wei balances, ordering and reload`, async () => withAPI(async call => {
    const accounts = (await call('/local-accounts')).body;
    // Values beyond floating-point precision, plus a one-wei final stage.
    const amounts = ['3000000000000001', '7000000000000002', '123456789123456789', '2', '1'].slice(0, count);
    const total = amounts.reduce((a, b) => a + BigInt(b), 0n);
    const milestones = amounts.map((amountWei, i) => ({ title: `Delivery ${i + 1}`, amountWei }));
    const created = await call('/projects', { name: 'API test', ...accounts, milestones, totalAmountWei: '999' });
    assert.equal(created.status, 201);
    assert.equal(created.body.totalAmountWei, total.toString());
    assert.equal(created.body.schemaVersion, 2);
    assert.equal(created.body.escrowBalanceWei, '0');
    assert.equal('totalEth' in created.body, false);
    const path = '/projects/' + created.body.id;
    const act = (action, milestoneId) => call(path + '/actions', { action, ...(milestoneId === undefined ? {} : { milestoneId }) });
    assert.equal((await act('acceptMilestone', 1)).status, 409);
    assert.equal((await act('stage1')).status, 400);
    assert.equal((await act('deploy')).status, 200);
    assert.equal((await act('deploy')).status, 409);
    assert.equal((await act('acceptMilestone', 1)).status, 409);
    for (const id of [0, count + 1, 1.5, '1', null]) assert.equal((await act('acceptMilestone', id)).status, 400);
    assert.equal((await act('acceptMilestone')).status, 400);
    assert.equal((await act('deposit', 1)).status, 400);
    assert.equal((await act('deposit')).body.escrowBalanceWei, total.toString());
    assert.equal((await act('deposit')).status, 409);
    let remaining = total;
    for (let id = 1; id <= count; id++) {
      if (id < count) assert.equal((await act('acceptMilestone', id + 1)).status, 409);
      const paid = await act('acceptMilestone', id);
      remaining -= BigInt(amounts[id - 1]);
      assert.equal(paid.status, 200);
      assert.equal(paid.body.escrowBalanceWei, remaining.toString());
      assert.deepEqual(paid.body.milestones.map(m => m.paid), amounts.map((_, i) => i < id));
      assert.deepEqual(paid.body.milestones.map(m => m.amountWei), amounts);
      assert.equal(paid.body.transactions.at(-1).milestoneId, id);
      assert.equal((await act('acceptMilestone', id)).status, 409);
      const reloaded = (await call(path)).body;
      assert.deepEqual(reloaded, paid.body);
    }
    const completed = (await call(path)).body;
    assert.equal(completed.transactions.length, count + 2);
    assert.ok(completed.transactions.every(t => t.status === 1 && /^0x[0-9a-f]{64}$/.test(t.hash)));
    assert.equal(completed.funded, true);
    assert.equal((await call('/projects/unknown')).status, 404);
  }));
}
test('HTTP API rejects malformed terms, overflow, foreign origins and invalid parties', async () => withAPI(async (call, base) => {
  const accounts = (await call('/local-accounts')).body;
  const good = { name: 'Validation', ...accounts, milestones: [{ title: 'Delivery', amountWei: '1' }] };
  for (const milestones of [undefined, null, [], Array(6).fill(good.milestones[0]), [null], [{ title: '', amountWei: '1' }], [{ title: 'x'.repeat(121), amountWei: '1' }],
    ...['0', '-1', '1.5', '01', '1e18', ' 1', '9'.repeat(79), (1n << 256n).toString(), 1].map(amountWei => [{ title: 'x', amountWei }]),
    [{ title: 'x', amountWei: ((1n << 256n) - 1n).toString() }, { title: 'y', amountWei: '1' }]]) {
    assert.equal((await call('/projects', { ...good, milestones })).status, 400);
  }
  assert.equal((await call('/projects', { ...good, clientWallet: 'x' })).status, 400);
  assert.equal((await call('/projects', { ...good, developerWallet: accounts.clientWallet })).status, 400);
  assert.equal((await call('/projects', null)).status, 400);
  const foreign = await fetch(base + '/projects', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  assert.equal((await call('/projects', good)).status, 201);
}));
