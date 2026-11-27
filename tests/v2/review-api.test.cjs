// A v2 review-period agreement over HTTP: the confirmed spec carries the review period, the
// checked contract is deployed, and deposit, delivery, change request, delivery, a fast-forward
// of the local clock, the provider's claim and a client approval run as confirmed plans.
// The generation result is a controlled fixture built from the reference v2 contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { createServer } = require('../../backend/server.cjs');
const { runPython } = require('../../backend/python-bridge.cjs');

const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, 'contracts', name), 'utf8');
const SETTINGS = { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } };
const PERIOD = 10 * 86400;

function reviewEnvelope(request) {
  const spec = request.payload.spec;
  const sources = { 'GeneratedMilestoneEscrow.sol': read('MilestoneReviewEscrow.sol').replace('contract MilestoneReviewEscrow ', 'contract GeneratedMilestoneEscrow '),
    'IMilestoneEscrow.sol': read('IMilestoneEscrow.sol'), 'IMilestoneReviewEscrow.sol': read('IMilestoneReviewEscrow.sol') };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const entry = out.contracts['GeneratedMilestoneEscrow.sol'].GeneratedMilestoneEscrow;
  const sourceBundle = { projectId: spec.projectId, specVersion: spec.specVersion, sources, entryFile: 'GeneratedMilestoneEscrow.sol',
    entryContract: 'GeneratedMilestoneEscrow', compilerVersion: '0.8.28', buildSettings: SETTINGS, dependencies: [] };
  // The same canonical hash as shared/handoff (sorted keys, no spaces).
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const keys = ['sources', 'entryFile', 'entryContract', 'compilerVersion', 'buildSettings', 'dependencies'];
  const hash = 'sha256:' + require('node:crypto').createHash('sha256')
    .update(JSON.stringify(canonical(Object.fromEntries(keys.map(k => [k, sourceBundle[k]]))))).digest('hex');
  sourceBundle.sourceHash = hash;
  const reportId = 'fixture-' + request.requestId;
  const validationReport = { reportId, projectId: spec.projectId, specVersion: spec.specVersion, sourceHash: hash,
    suiteVersion: 'synthetic-http-test-only;review-v1', mode: 'development', status: 'passed',
    checks: ['compilation', 'staticAnalysis', 'clauseTests'].map(name => ({ name, status: 'passed', findings: [] })),
    artifact: { abi: entry.abi, bytecode: '0x' + entry.evm.bytecode.object, compilerVersion: '0.8.28', buildSettings: SETTINGS,
      sourceHash: hash, constructorTypes: ['address', 'address', 'uint256[]'] } };
  return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [],
    result: { status: 'validated', sourceBundle, validationReport, attempts: [{ attempt: 0, sourceHash: hash, reportId, feedbackUsed: [] }] } };
}

test('a review-period agreement runs delivery, change request, timeout and claim through confirmed plans', { timeout: 120000 }, async () => {
  const seen = [];
  const server = await createServer({
    generation: { enabled: true, runner: async request => { seen.push(request.payload.spec); return reviewEnvelope(request); } },
    operations: { enabled: true, runner: (request, options) => runPython(request, options) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (url, data) => {
    const r = await fetch(base + url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const accounts = (await call('/local-accounts')).body;
    const created = await call('/projects', { name: 'Review period', clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones: [{ title: 'Design', amountWei: '3000000000000000' }, { title: 'Launch', amountWei: '7000000000000000' }],
      reviewPeriodSeconds: PERIOD, changeRequestLimit: 0 });
    assert.equal(created.status, 201);
    const p = `/projects/${created.body.id}`;
    assert.equal((await call('/projects', { ...created.body, name: 'Bad', reviewPeriodSeconds: 5 })).status, 400);
    const agreement = (await call(p + '/agreement')).body;
    assert.equal(agreement.spec.reviewPeriodSeconds, PERIOD);
    assert.equal(agreement.spec.changeRequestLimit, 0);
    const confirmation = (await call(p + '/confirmation', { specVersion: 1, approved: true })).body.confirmation;
    const run = (await call(p + '/generation-runs', { specVersion: 1, confirmationId: confirmation.confirmationId, idempotencyKey: 'review-run-1' })).body;
    for (let i = 0; i < 100 && !(await call(`${p}/generation-runs/${run.id}`)).body.finishedAt; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(seen[0].reviewPeriodSeconds, PERIOD);
    const deployed = await call(`${p}/generation-runs/${run.id}/deployment`, { approved: true, specVersion: 1, confirmationId: confirmation.confirmationId });
    assert.equal(deployed.status, 201);
    assert.equal(deployed.body.review.periodSeconds, PERIOD);

    async function act(action, milestoneId) {
      const plan = await call(p + '/action-plans', action === 'deposit' ? { action } : { action, milestoneId });
      if (plan.status !== 200) return plan;
      const done = await call(`${p}/plans/${plan.body.planId}/confirmation`, { approved: true });
      assert.equal(done.status, 200);
      assert.equal(done.body.report.outcome, 'confirmed', done.body.report.summary);
      return { status: 200, plan: plan.body, ...done.body };
    }
    // Nothing to claim or review before a delivery; the client may not deliver for the provider.
    assert.equal((await act('claimMilestone', 1)).status, 409);
    await act('deposit');
    assert.equal((await act('requestChanges', 1)).status, 409);
    const delivered = await act('submitDelivery', 1);
    assert.match(delivered.plan.summary, /Mark milestone #1 "Design" as delivered\. The client then has 10 days/);
    assert.equal(delivered.plan.payment, null);
    assert.match(delivered.report.summary, /is marked delivered/);
    assert.ok(delivered.project.milestones[0].deliveredAt > 0);
    // The provider cannot claim while the review runs; the client asks for changes.
    assert.equal((await act('claimMilestone', 1)).status, 409);
    const changes = await act('requestChanges', 1);
    assert.equal(changes.project.milestones[0].deliveredAt, 0);
    assert.equal(changes.project.milestones[0].changeRequests, 1);
    const again = await act('submitDelivery', 1);
    const ends = again.project.milestones[0].deliveredAt + PERIOD;
    // Fast-forward the local clock past the review period; then the claim pays milestone 1.
    assert.equal((await call(p + '/clock', { advanceSeconds: 0 })).status, 400);
    const later = await call(p + '/clock', { advanceSeconds: PERIOD + 60 });
    assert.equal(later.status, 200);
    assert.ok(later.body.review.chainTime >= ends);
    assert.equal((await act('requestChanges', 1)).status, 409);
    const claimed = await act('claimMilestone', 1);
    assert.equal(claimed.plan.payment.amountWei, '3000000000000000');
    assert.equal(claimed.project.milestones[0].paid, true);
    assert.equal(claimed.project.escrowBalanceWei, '7000000000000000');
    // v1 still holds: the client approves milestone 2 without any delivery.
    const approved = await act('acceptMilestone', 2);
    assert.equal(approved.project.escrowBalanceWei, '0');
    assert.deepEqual(approved.project.transactions.map(t => t.action),
      ['deploy', 'deposit', 'submitDelivery', 'requestChanges', 'submitDelivery', 'claimMilestone', 'acceptMilestone']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
