// Real HTTP boundaries with injected workers only: no models, deployment or transactions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: pause } = require('node:timers/promises');
const { createServer } = require('../backend/server.cjs');
const { RUN_CONFIG } = require('../backend/generation.cjs');

const copy = value => structuredClone(value);
function controlledWorker() {
  const calls = [];
  return { calls, runner: request => new Promise((resolve, reject) => calls.push({ request, resolve, reject })) };
}
function ready(request, accounts, changes = {}) {
  return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [], result: {
    status: 'readyForConfirmation', questions: [], unsupportedTerms: [], separateTerms: [],
    draftSpec: { schemaVersion: 1, projectId: request.payload.draftSpec.projectId, specVersion: 1,
      name: 'Website agreement', clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones: [{ id: 1, title: 'Approved homepage', amountWei: '3000000000000001' },
        { id: 2, title: 'Checkout acceptance tests', amountWei: '7000000000000002' }],
      totalAmountWei: '10000000000000003', approvalRole: 'client', refundPolicy: 'none', deadline: null },
    ...changes } };
}
function message(content = 'Use the agreed homepage and checkout payment schedule.', expectedRevision = 0, requestKey = 'draft-message-001') {
  return { message: content, expectedRevision, requestKey };
}
async function until(read, description) {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (value) return value;
    await pause(10);
  } while (Date.now() < deadline);
  assert.fail(description);
}
async function withAPI(drafting, run, generation = {}) {
  const server = await createServer({ drafting, generation: { enabled: false, ...generation }, operations: { enabled: false } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data, method = data === undefined ? 'GET' : 'POST', signal) => {
    const response = await fetch(base + path, { method, signal, ...(data === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  const create = async () => {
    const response = await call('/drafts', {});
    assert.equal(response.status, 201);
    return { draft: response.body, path: `/drafts/${response.body.id}` };
  };
  try {
    const context = await call('/drafts/context');
    assert.equal(context.status, 200);
    await run({ call, create, accounts: context.body, context: context.body });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('disabled drafting reports its mode and never dispatches a message or confirms an empty draft', async () => {
  let calls = 0;
  await withAPI({ enabled: false, runner: async () => { calls++; } }, async ({ call, create, context }) => {
    assert.equal(context.clarificationEnabled, false);
    assert.equal(context.mode, 'local-chain');
    const { draft, path } = await create();
    assert.equal((await call(path + '/messages', message())).status, 503);
    assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 0 })).status, 409);
    assert.deepEqual((await call(path)).body, draft);
    assert.equal(calls, 0);
  });
});

test('English conversation turns show one stable question while retaining every internal blocker', async () => {
  let accounts, phase = 'incomplete', reverse = false, calls = 0;
  await withAPI({ enabled: true, runner: async request => {
    calls++;
    const response = ready(request, accounts);
    response.result.draftSpec.totalAmountWei = '10000000000000000';
    response.result.draftSpec.milestones[0].amountWei = '3000000000000000';
    response.result.draftSpec.milestones[1].amountWei = '7000000000000000';
    if (phase !== 'ready') {
      response.result.status = 'needsClarification';
      response.result.draftSpec.clientWallet = response.result.draftSpec.developerWallet = null;
      response.result.questions = [
        { field: 'developerWallet', question: 'What is the provider wallet?' },
        { field: 'clientWallet', question: 'What is the client wallet?' },
      ];
      if (phase === 'incomplete') {
        response.result.draftSpec.totalAmountWei = null;
        response.result.draftSpec.milestones.forEach(m => { m.amountWei = null; });
        response.result.questions.push({ field: 'totalAmountWei', question: 'What is the total?' },
          { field: 'milestones.1.amountWei', question: 'What is the first payment?' });
      }
      if (reverse) response.result.questions.reverse();
    }
    return response;
  } }, async ({ call, create, accounts: local }) => {
    accounts = local;
    const { path } = await create();
    const first = await call(path + '/messages', message('Build a website with separate homepage and complete-site acceptance.'));
    assert.equal(first.status, 200);
    assert.equal(first.body.result.questions.length, 4);
    const turn = first.body.turns[0];
    assert.equal(turn.revision, 1);
    assert.equal(turn.question.field, 'totalAmountWei');
    assert.match(turn.question.question, /total amount in ETH/);
    assert.equal((turn.question.question.match(/\?/g) ?? []).length, 1);
    assert.equal(turn.reply.includes(turn.question.question), false);
    reverse = true;
    const second = await call(path + '/messages', message('The amount is still undecided.', 1, 'chat-turn-two'));
    assert.deepEqual(second.body.turns[0], turn);
    assert.deepEqual(second.body.turns[1].question, turn.question);
    assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 2 })).status, 409);
    phase = 'wallets';
    const third = await call(path + '/messages', message('Total 0.01 test ETH, split 30%/70%.', 2, 'chat-turn-three'));
    assert.equal(third.body.turns[2].question.field, 'clientWallet');
    assert.match(third.body.turns[2].reply, /0\.01 ETH/);
    assert.match(third.body.turns[2].reply, /0\.003 ETH, 0\.007 ETH/);
    phase = 'ready';
    const finalBody = message(accounts.clientWallet + ' ' + accounts.developerWallet, 3, 'chat-turn-four');
    const final = await call(path + '/messages', finalBody);
    assert.equal(final.body.turns[3].question, null);
    assert.match(final.body.turns[3].reply, /Review the summary before explicitly confirming/);
    assert.match(final.body.turns[3].reply, /client funding address/);
    assert.equal(final.body.turns.length, final.body.messages.length);
    assert.deepEqual((await call(path)).body.turns, final.body.turns);
    assert.deepEqual((await call(path + '/messages', finalBody)).body.turns, final.body.turns);
    assert.equal(calls, 4);
  });
});

test('unsupported terms take priority without hiding the remaining questions', async () => {
  let accounts;
  await withAPI({ enabled: true, runner: async request => ready(request, accounts, {
    status: 'unsupported', unsupportedTerms: ['Automatic refund for late delivery; the current contract has no refund operation.'],
    questions: [{ field: 'clientWallet', question: 'What is the client wallet?' },
      { field: 'acceptance', question: 'Which mockup determines acceptance? How many revisions are included?' }],
  }) }, async ({ call, create, accounts: local }) => {
    accounts = local;
    const { path } = await create();
    const result = await call(path + '/messages', message('Require an automatic refund for late delivery and clarify the acceptance criteria.'));
    assert.equal(result.status, 200);
    assert.equal(result.body.turns[0].question.field, 'unsupportedTerms.0');
    assert.equal((result.body.turns[0].question.question.match(/\?/g) ?? []).length, 1);
    assert.equal(result.body.result.questions.length, 2);
    assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 1 })).status, 409);
  });
});

test('busy drafts survive refresh and a lost response can be replayed without another model call', async () => {
  const worker = controlledWorker();
  await withAPI({ enabled: true, runner: worker.runner }, async ({ call, create, accounts }) => {
    const { path } = await create();
    const body = message();
    const abort = new AbortController();
    const first = call(path + '/messages', body, 'POST', abort.signal).then(value => ({ value }), error => ({ error }));
    await until(() => worker.calls[0], 'First message did not reach the worker');
    try {
      const refreshing = (await call(path)).body;
      assert.equal(refreshing.busy, true);
      assert.equal(refreshing.revision, 0);
      assert.equal(refreshing.result, null);
      assert.equal(refreshing.pendingMessage.content, body.message);
      assert.deepEqual(refreshing.messages, []);
      assert.deepEqual(refreshing.turns, []);
      assert.equal('history' in refreshing, false);
      assert.equal('keys' in refreshing, false);
      assert.equal((await call(path + '/messages', body)).status, 409);
      assert.equal((await call(path + '/messages', message('Another message', 0, 'draft-message-002'))).status, 409);
      assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 0 })).status, 409);
      assert.equal(worker.calls.length, 1);
      // Disconnect after the server accepted the request, then let the worker finish.
      abort.abort();
      assert.equal((await first).error.name, 'AbortError');
      worker.calls[0].resolve(ready(worker.calls[0].request, accounts));
      const recovered = await until(async () => {
        const current = (await call(path)).body;
        return current.revision === 1 && !current.busy && current;
      }, 'Accepted message was not recoverable after disconnect');
      assert.equal(recovered.pendingMessage, null);
      assert.deepEqual(recovered.messages, [{ role: 'user', content: body.message }]);
      assert.equal(recovered.turns.length, 1);
      assert.equal(recovered.turns[0].question, null);
      const replay = await call(path + '/messages', body);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, recovered);
      assert.equal((await call(path + '/messages', { ...body, message: 'Different wording' })).status, 409);
      assert.equal((await call(path + '/messages', { ...body, expectedRevision: 1 })).status, 409);
      assert.equal(worker.calls.length, 1);
    } finally {
      worker.calls[0].resolve(ready(worker.calls[0].request, accounts));
      abort.abort();
      await first;
    }
  });
});

test('stale revisions and caller-supplied results cannot overwrite or confirm a newer draft', async () => {
  let accounts, calls = 0;
  await withAPI({ enabled: true, runner: async request => { calls++; return ready(request, accounts); } },
    async ({ call, create, accounts: local }) => {
      accounts = local;
      const { path } = await create();
      const current = (await call(path + '/messages', message())).body;
      assert.equal(current.revision, 1);
      assert.equal((await call(path + '/messages', message('Change the price', 0, 'stale-message-002'))).status, 409);
      assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 0 })).status, 409);
      assert.equal((await call(path + '/messages', { ...message('New text', 1, 'new-message-002'), result: current.result })).status, 400);
      for (const approved of [false, 'true', null])
        assert.equal((await call(path + '/confirmation', { approved, expectedRevision: 1 })).status, 400);
      assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: '1' })).status, 400);
      assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 1, draftSpec: current.result.draftSpec })).status, 400);
      assert.deepEqual((await call(path)).body, current);
      assert.equal(calls, 1);
    });
});

test('missing fields and unsupported payment conditions stay visible and cannot create a project', async () => {
  let accounts, kind;
  await withAPI({ enabled: true, runner: async request => {
    const response = ready(request, accounts);
    if (kind === 'missing') {
      response.result.status = 'needsClarification';
      response.result.draftSpec.developerWallet = null;
      response.result.questions = [{ field: 'developerWallet', question: 'Which wallet belongs to the provider?' }];
    } else {
      response.result.status = 'unsupported';
      response.result.unsupportedTerms = ['Refund the last installment if delivery is late; v1 cannot refund.'];
    }
    return response;
  } }, async ({ call, create, accounts: local }) => {
    accounts = local;
    for (kind of ['missing', 'refund']) {
      const { path } = await create();
      const response = await call(path + '/messages', message());
      assert.equal(response.status, 200);
      assert.equal(response.body.result.status, kind === 'missing' ? 'needsClarification' : 'unsupported');
      assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 1 })).status, 409);
      assert.deepEqual((await call(path)).body.result, response.body.result);
      assert.equal((await call(path)).body.confirmedProjectId, null);
    }
  });
});

test('full prior results and sourced separate terms reach subsequent clarification turns', async () => {
  let accounts;
  const seen = [], note = 'Both parties retain confidentiality in a separate written agreement.';
  await withAPI({ enabled: true, runner: async request => {
    seen.push(copy(request));
    return ready(request, accounts, { status: 'unsupported', separateTerms: [note],
      questions: [{ field: 'refund', question: 'How should the refund condition be handled?' }],
      unsupportedTerms: ['A late-delivery refund is required and is not implemented.'] });
  } }, async ({ call, create, accounts: local }) => {
    accounts = local;
    const { path, draft } = await create();
    const firstMessage = message('Use the stage schedule. ' + note);
    const first = await call(path + '/messages', firstMessage);
    assert.equal(first.status, 200);
    const secondMessage = message('Here is the provider wallet again: ' + accounts.developerWallet, 1, 'history-message-002');
    const second = await call(path + '/messages', secondMessage);
    assert.equal(second.status, 200);
    assert.deepEqual(seen[0].payload.history, []);
    assert.equal(seen[0].payload.draftSpec.projectId, draft.id);
    assert.deepEqual(seen[1].payload.draftSpec, first.body.result.draftSpec);
    assert.deepEqual(seen[1].payload.history, [
      { role: 'user', content: firstMessage.message },
      { role: 'assistant', content: JSON.stringify({ result: first.body.result, separateTerms: [note], question: first.body.turns[0].question }) }
    ]);
    assert.deepEqual(second.body.result.separateTerms, [note]);
    assert.deepEqual(second.body.messages, [firstMessage, secondMessage].map(item => ({ role: 'user', content: item.message })));
    assert.equal(second.body.result.draftSpec.specVersion, 2);
    assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 2 })).status, 409);
  });
});

test('failed follow-ups preserve the last draft and the pending message until the same request is retried', async () => {
  let accounts;
  const seen = [];
  await withAPI({ enabled: true, runner: async request => {
    seen.push(copy(request));
    if (seen.length === 2) throw new Error('PYTHON_TIMEOUT private-diagnostic-do-not-expose');
    return ready(request, accounts);
  } }, async ({ call, create, accounts: local }) => {
    accounts = local;
    const { path } = await create();
    const first = (await call(path + '/messages', message())).body;
    const followup = message('Before I approve, please retain this updated acceptance wording.', 1, 'retry-message-002');
    const failed = await call(path + '/messages', followup);
    assert.equal(failed.status, 502);
    assert.equal(JSON.stringify(failed.body).includes('private-diagnostic'), false);
    const recovered = (await call(path)).body;
    assert.equal(recovered.revision, 1);
    assert.equal(recovered.busy, false);
    assert.deepEqual(recovered.result, first.result);
    assert.deepEqual(recovered.messages, first.messages);
    assert.deepEqual(recovered.turns, first.turns);
    assert.deepEqual(recovered.pendingMessage, { content: followup.message, requestKey: followup.requestKey, expectedRevision: 1 });
    assert.ok(recovered.lastError);
    assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 1 })).status, 409);
    assert.equal((await call(path + '/messages', { ...followup, message: 'Ignore my pending change' })).status, 409);
    assert.equal((await call(path + '/messages', { ...followup, requestKey: 'different-retry-key' })).status, 409);
    assert.equal(seen.length, 2);
    const retried = await call(path + '/messages', followup);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.revision, 2);
    assert.equal(retried.body.pendingMessage, null);
    assert.equal(retried.body.lastError, null);
    assert.equal(retried.body.messages.length, 2);
    assert.equal(retried.body.turns.length, 2);
    assert.deepEqual(seen[2].payload, seen[1].payload);
    assert.equal((await call(path + '/messages', followup)).body.revision, 2);
    assert.equal(seen.length, 3);
  });
});

test('invalid or incomplete model handoffs never replace the reviewed draft or enable confirmation', async t => {
  let accounts, corrupt;
  const variants = [
    ['truncated JSON response', () => '{"status":"ok"'],
    ['missing questions field', response => { delete response.result.questions; return response; }],
    ['incomplete ready draft', response => { response.result.draftSpec.clientWallet = null; return response; }],
    ['ready with an unresolved condition', response => { response.result.unsupportedTerms = ['Refund required']; return response; }],
    ['wrong conversation identity', response => { response.result.draftSpec.projectId = 'other-draft'; return response; }],
    ['inconsistent money', response => { response.result.draftSpec.totalAmountWei = '1'; return response; }],
    ['invented separate terms', response => { response.result.separateTerms = ['Not said by either party']; return response; }]
  ];
  await withAPI({ enabled: true, runner: async request => {
    const response = ready(request, accounts);
    return corrupt ? corrupt(response) : response;
  } }, async ({ call, create, accounts: local }) => {
    accounts = local;
    for (const [name, alter] of variants) await t.test(name, async () => {
      corrupt = null;
      const { path } = await create();
      const original = (await call(path + '/messages', message())).body;
      corrupt = alter;
      const followup = message('Please recheck the unchanged terms.', 1, 'invalid-message-002');
      assert.equal((await call(path + '/messages', followup)).status, 502);
      const current = (await call(path)).body;
      assert.deepEqual(current.result, original.result);
      assert.deepEqual(current.messages, original.messages);
      assert.equal(current.revision, 1);
      assert.equal(current.busy, false);
      assert.equal(current.pendingMessage.requestKey, followup.requestKey);
      assert.ok(current.lastError);
      assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 1 })).status, 409);
      assert.equal(current.confirmedProjectId, null);
    });
  });
});

test('local mode rejects external or reversed wallets at confirmation and allows a corrected draft', async () => {
  let accounts, walletMode = 'external';
  await withAPI({ enabled: true, runner: async request => {
    const response = ready(request, accounts);
    if (walletMode === 'external') response.result.draftSpec.developerWallet = '0x' + '3'.repeat(40);
    if (walletMode === 'reversed') {
      response.result.draftSpec.clientWallet = accounts.developerWallet;
      response.result.draftSpec.developerWallet = accounts.clientWallet;
    }
    return response;
  } }, async ({ call, create, accounts: local }) => {
    accounts = local;
    const { path } = await create();
    for (const [index, mode] of ['external', 'reversed'].entries()) {
      walletMode = mode;
      assert.equal((await call(path + '/messages', message('Review the participants.', index, `wallet-message-00${index}`))).status, 200);
      const refused = await call(path + '/confirmation', { approved: true, expectedRevision: index + 1 });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /local demo accounts/i);
      assert.equal((await call(path)).body.confirmedProjectId, null);
    }
    walletMode = 'local';
    await call(path + '/messages', message('Use the displayed local client and provider.', 2, 'wallet-correction-003'));
    assert.equal((await call(path + '/confirmation', { approved: true, expectedRevision: 3 })).status, 201);
  });
});

test('confirmation is replayable, seals its source draft and directly supplies the existing generation flow', async () => {
  let accounts;
  const generation = controlledWorker();
  const note = 'The parties retain attribution in a separate agreement.';
  await withAPI({ enabled: true, runner: async request => {
    const response = ready(request, accounts, { separateTerms: [note] });
    response.result.draftSpec.specVersion = 99; // The server owns the displayed revision.
    return response;
  } }, async ({ call, create, accounts: local }) => {
    accounts = local;
    const { path, draft } = await create();
    await call(path + '/messages', message('Use the agreed schedule. ' + note));
    const latest = (await call(path + '/messages', message('Keep these exact amounts.', 1, 'final-message-002'))).body;
    assert.equal(latest.revision, 2);
    assert.equal(latest.result.draftSpec.specVersion, 2);
    const body = { approved: true, expectedRevision: 2 };
    const confirmed = await call(path + '/confirmation', body);
    assert.equal(confirmed.status, 201);
    const { project, agreement } = confirmed.body;
    const projectPath = `/projects/${project.id}`;
    assert.deepEqual(agreement.draftOrigin, { draftId: draft.id, revision: 2 });
    assert.equal(agreement.spec.projectId, project.id);
    assert.equal(agreement.spec.specVersion, 1);
    assert.deepEqual(agreement.spec.milestones, latest.result.draftSpec.milestones);
    assert.equal(agreement.spec.totalAmountWei, latest.result.draftSpec.totalAmountWei);
    assert.equal(agreement.confirmation.projectId, project.id);
    assert.equal(agreement.confirmation.specVersion, 1);
    assert.ok(agreement.confirmation.confirmationId);
    assert.equal(project.contractAddress, null);
    assert.deepEqual(project.transactions, []);
    // The first response may be lost: GET and repeated confirmations recover the same project.
    assert.equal((await call(path)).body.confirmedProjectId, project.id);
    for (const replay of await Promise.all([call(path + '/confirmation', body), call(path + '/confirmation', body)])) {
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, confirmed.body);
    }
    assert.equal((await call(path + '/messages', message('Change the budget now.', 2, 'sealed-message-003'))).status, 409);
    const replacement = { name: project.name, clientWallet: project.clientWallet, developerWallet: project.developerWallet,
      milestones: [{ title: 'Changed', amountWei: '1' }] };
    assert.equal((await call(projectPath + '/terms', { expectedSpecVersion: 1, draft: replacement }, 'PUT')).status, 409);
    assert.deepEqual((await call(projectPath + '/agreement')).body, agreement);
    assert.deepEqual((await call(path)).body.result.separateTerms, [note]);
    assert.equal((await call(projectPath + '/actions', { action: 'deploy' })).status, 409);
    assert.equal((await call(projectPath)).body.contractAddress, null);
    const start = { specVersion: agreement.spec.specVersion, confirmationId: agreement.confirmation.confirmationId,
      idempotencyKey: 'confirmed-draft-generation' };
    const started = await call(projectPath + '/generation-runs', start);
    assert.equal(started.status, 202);
    const dispatch = await until(() => generation.calls[0], 'Confirmed draft did not reach generation');
    assert.equal(dispatch.request.operation, 'generate');
    assert.deepEqual(dispatch.request.payload.spec, agreement.spec);
    assert.deepEqual(dispatch.request.payload.confirmation, agreement.confirmation);
    assert.deepEqual(dispatch.request.payload.runConfig, RUN_CONFIG);
    assert.equal('separateTerms' in dispatch.request.payload.spec, false);
    const repeated = await call(projectPath + '/generation-runs', start);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.id, started.body.id);
    assert.equal(generation.calls.length, 1);
    // A synthetic failed generation ends the flow without pretending validation passed.
    dispatch.resolve({ interfaceVersion: 1, requestId: dispatch.request.requestId, status: 'ok', errors: [],
      result: { status: 'failed', sourceBundle: null, validationReport: null, attempts: [] } });
    const settled = await until(async () => {
      const current = (await call(projectPath + '/generation-runs/' + started.body.id)).body;
      return current.finishedAt && current;
    }, 'Injected generation did not settle');
    assert.equal(settled.status, 'completed');
    assert.equal(settled.result.status, 'failed');
    assert.equal(settled.generatedDeploymentEnabled, false);
    assert.deepEqual((await call(projectPath)).body.transactions, []);
  }, { enabled: true, runner: generation.runner });
});
