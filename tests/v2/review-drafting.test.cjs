// v2 review period from conversation to confirmed agreement, over real HTTP with an injected
// Agent 1 reply (no model calls, no chain transactions).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../../backend/server.cjs');

const DAY = 86400;
function reply(request, accounts, review) {
  return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [], result: {
    status: 'readyForConfirmation', questions: [], unsupportedTerms: [], separateTerms: [],
    draftSpec: { schemaVersion: 1, projectId: request.payload.draftSpec?.projectId ?? 'review-draft', specVersion: 1,
      name: 'Software development', clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones: [{ id: 1, title: 'Prototype', amountWei: '4000000000000000' },
        { id: 2, title: 'Final release', amountWei: '6000000000000000' }],
      totalAmountWei: '10000000000000000', approvalRole: 'client', refundPolicy: 'none', deadline: null, ...review } } };
}
async function withAPI(runner, run) {
  const server = await createServer({ drafting: { enabled: true, runner },
    generation: { enabled: false }, operations: { enabled: false } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data) => {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST',
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run(call, (await call('/drafts/context')).body);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
const lastReply = session => session.turns.at(-1).reply;

test('a contract review period is announced once, confirmed into the project and handed to generation', async () => {
  let accounts, review = { reviewPeriodSeconds: 10 * DAY, changeRequestLimit: 2 };
  await withAPI(async request => reply(request, accounts, review), async (call, context) => {
    accounts = context;
    const draft = (await call('/drafts', {})).body, path = `/drafts/${draft.id}`;
    const first = (await call(path + '/messages', { message: 'Deemed accepted if no Change Request within ten (10) days.',
      expectedRevision: 0, requestKey: 'review-001' })).body;
    assert.match(lastReply(first), /Review: after each delivery the client has 10 days to approve or ask for changes \(up to 2 times\)\. With no answer, the provider can claim the payment\./);
    const again = (await call(path + '/messages', { message: 'Keep it as is.', expectedRevision: 1, requestKey: 'review-002' })).body;
    assert.doesNotMatch(lastReply(again), /Review:/);
    const confirmed = await call(path + '/confirmation', { approved: true, expectedRevision: 2 });
    assert.equal(confirmed.status, 201);
    const { project, agreement } = confirmed.body;
    assert.equal(project.reviewPeriodSeconds, 10 * DAY);
    assert.equal(project.changeRequestLimit, 2);
    assert.equal(agreement.spec.reviewPeriodSeconds, 10 * DAY);
    assert.equal(agreement.spec.changeRequestLimit, 2);
  });
});

test('turning the review period off says so and confirms a v1 agreement', async () => {
  let accounts, review = { reviewPeriodSeconds: 14 * DAY, changeRequestLimit: 0 };
  await withAPI(async request => reply(request, accounts, review), async (call, context) => {
    accounts = context;
    const draft = (await call('/drafts', {})).body, path = `/drafts/${draft.id}`;
    const added = (await call(path + '/messages', { message: 'Release each payment if the client does not respond within 14 days.',
      expectedRevision: 0, requestKey: 'review-101' })).body;
    assert.match(lastReply(added), /the client has 14 days to approve or ask for changes\. With no answer/);
    review = {};
    const removed = (await call(path + '/messages', { message: 'No automatic payment.', expectedRevision: 1, requestKey: 'review-102' })).body;
    assert.match(lastReply(removed), /Automatic payment after review is off: the client approves every payment\./);
    const { project, agreement } = (await call(path + '/confirmation', { approved: true, expectedRevision: 2 })).body;
    assert.equal(project.reviewPeriodSeconds, undefined);
    assert.equal(agreement.spec.reviewPeriodSeconds, undefined);
  });
});
