// Project and draft lists over real HTTP with a saved local chain. Injected workers only: no model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../backend/server.cjs');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, ...(data === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return { call, close };
}
function readyDraft(request, accounts, milestones) {
  return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [], result: {
    status: 'readyForConfirmation', questions: [], unsupportedTerms: [], separateTerms: [],
    draftSpec: { schemaVersion: 1, projectId: request.payload.draftSpec.projectId, specVersion: 1,
      name: 'Bakery website', clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones, totalAmountWei: milestones.reduce((sum, m) => sum + BigInt(m.amountWei), 0n).toString(),
      approvalRole: 'client', refundPolicy: 'none', deadline: null } } };
}
const byId = (list, id) => list.find(item => item.id === id);

test('project list summarizes saved projects and survives a backend restart without new transactions', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'local-escrow-list-'));
  const options = { stateDirectory, generation: { enabled: false }, operations: { enabled: false }, drafting: { enabled: false } };
  let api = await listen(await createServer(options));
  try {
    let { call } = api;
    assert.deepEqual((await call('/projects')).body, { projects: [] });
    const accounts = (await call('/local-accounts')).body;
    const terms = { clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones: [{ title: 'Homepage', amountWei: '3000000000000000' }, { title: 'Full site', amountWei: '7000000000000000' }] };
    const reference = (await call('/projects', { name: 'Reference bakery', ...terms })).body;
    const fresh = (await call('/projects', { name: 'Not deployed yet', ...terms })).body;
    const agreement = (await call('/projects', { name: 'Confirmed agreement', ...terms })).body;
    assert.equal((await call(`/projects/${agreement.id}/confirmation`, { specVersion: 1, approved: true })).status, 200);
    const act = body => call(`/projects/${reference.id}/actions`, body);
    assert.equal((await act({ action: 'deploy' })).status, 200);
    assert.equal((await act({ action: 'deposit' })).status, 200);
    const paid = await act({ action: 'acceptMilestone', milestoneId: 1 });
    assert.equal(paid.status, 200);

    const listed = await call('/projects');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.projects.map(p => p.id).sort(), [reference.id, fresh.id, agreement.id].sort());
    assert.deepEqual(byId(listed.body.projects, reference.id), {
      id: reference.id, name: 'Reference bakery', kind: 'reference', stage: 'paying', createdAt: reference.createdAt,
      contractAddress: paid.body.contractAddress, totalAmountWei: '10000000000000000', milestoneCount: 2,
      funded: true, escrowBalanceWei: '7000000000000000', paidCount: 1 });
    assert.equal(byId(listed.body.projects, fresh.id).stage, 'notDeployed');
    assert.equal(byId(listed.body.projects, fresh.id).kind, 'reference');
    assert.equal(byId(listed.body.projects, agreement.id).stage, 'readyToGenerate');
    assert.equal(byId(listed.body.projects, agreement.id).kind, 'agreement');
    const times = listed.body.projects.map(p => p.createdAt);
    assert.deepEqual(times, [...times].sort().reverse());

    // A normal restart reloads the same list, receipts and balance; listing sends nothing.
    await api.close();
    api = await listen(await createServer(options));
    ({ call } = api);
    const reloaded = await call('/projects');
    assert.deepEqual(reloaded.body, listed.body);
    const project = (await call(`/projects/${reference.id}`)).body;
    assert.deepEqual(project.transactions, paid.body.transactions);
    assert.equal(project.transactions.length, 3);
    assert.equal((await act({ action: 'acceptMilestone', milestoneId: 1 })).status, 409);
    const finished = await act({ action: 'acceptMilestone', milestoneId: 2 });
    assert.equal(finished.status, 200);
    const complete = byId((await call('/projects')).body.projects, reference.id);
    assert.equal(complete.stage, 'complete');
    assert.equal(complete.paidCount, 2);
    assert.equal(complete.escrowBalanceWei, '0');
  } finally {
    await api.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('draft list shows unfinished conversations until confirmation turns them into projects', async () => {
  let accounts;
  const milestones = [{ id: 1, title: 'Finished website', amountWei: '10000000000000000' }];
  const api = await listen(await createServer({ generation: { enabled: false }, operations: { enabled: false },
    drafting: { enabled: true, runner: async request => readyDraft(request, accounts, milestones) } }));
  try {
    const { call } = api;
    accounts = (await call('/local-accounts')).body;
    const empty = (await call('/drafts', {})).body;
    assert.deepEqual((await call('/drafts')).body, { drafts: [] }, 'A draft without messages is not listed');
    const draft = (await call('/drafts', {})).body;
    const replied = await call(`/drafts/${draft.id}/messages`, { message: 'My cousin builds the bakery website.',
      expectedRevision: 0, requestKey: 'list-message-001' });
    assert.equal(replied.status, 200);
    assert.match(replied.body.turns.at(-1).reply, /Recorded 1 delivery milestone: 1\. Finished website\./);
    const drafts = (await call('/drafts')).body.drafts;
    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0], { id: draft.id, name: 'Bakery website', createdAt: draft.createdAt,
      updatedAt: replied.body.updatedAt, status: 'readyForConfirmation', messageCount: 1, awaitingReply: false });
    assert.equal(byId(drafts, empty.id), undefined);

    const confirmed = await call(`/drafts/${draft.id}/confirmation`, { approved: true, expectedRevision: 1 });
    assert.equal(confirmed.status, 201);
    assert.deepEqual((await call('/drafts')).body.drafts, []);
    const project = byId((await call('/projects')).body.projects, confirmed.body.project.id);
    assert.equal(project.kind, 'agreement');
    assert.equal(project.stage, 'readyToGenerate');
    assert.equal(project.name, 'Bakery website');
  } finally { await api.close(); }
});
