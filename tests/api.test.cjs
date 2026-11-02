const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../backend/server.cjs');
test('HTTP API executes chain transactions and rejects invalid requests', async () => {
  const server = await createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data) => {
    const r = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const accounts = (await call('/local-accounts')).body;
    assert.equal((await call('/projects', {name:'bad',clientWallet:'x',developerWallet:'y'})).status,400);
    const foreign = await fetch(base+'/projects', {method:'POST',headers:{Origin:'https://untrusted.example'},body:'{}'});
    assert.equal(foreign.status,403);
    const created = await call('/projects', {name:'API test',...accounts});
    assert.equal(created.status,201);
    const path = '/projects/' + created.body.id;
    const act = action => call(path+'/actions',{action});
    assert.equal((await act('stage1')).status,409);
    assert.equal((await act('unknown')).status,400);
    assert.equal((await act('deploy')).status,200);
    assert.equal((await act('deploy')).status,409);
    assert.equal((await act('stage1')).status,409);
    assert.equal((await act('deposit')).body.escrowBalanceWei,'10000000000000000');
    assert.equal((await act('stage2')).status,409);
    const first = await act('stage1');
    assert.equal(first.body.escrowBalanceWei,'7000000000000000');
    assert.equal((await act('stage1')).status,409);
    const second = await act('stage2');
    assert.equal(second.body.escrowBalanceWei,'0');
    assert.deepEqual(second.body.paid,{stage1:true,stage2:true});
    assert.equal(second.body.transactions.length,4);
    assert.ok(second.body.transactions.every(t=>t.status===1 && /^0x[0-9a-f]{64}$/.test(t.hash)));
    assert.equal((await call(path)).body.chainState,3);
    assert.equal((await call('/projects/unknown')).status,404);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
