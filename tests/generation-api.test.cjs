// HTTP integration tests with controlled worker responses: no paid model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: pause } = require('node:timers/promises');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('../backend/server.cjs');
const { RUN_CONFIG } = require('../backend/generation.cjs');
const bundleFixture = require('../shared/examples/source-bundle.json');
const { compile } = require('../scripts/compile.cjs');
let compiledFixture;

function envelope(request, status = 'failed') {
  const spec = request.payload.spec;
  const sourceBundle = { ...structuredClone(bundleFixture), projectId: spec.projectId, specVersion: spec.specVersion };
  const reportId = `fixture-${request.requestId}`;
  const validationReport = { reportId, projectId: spec.projectId, specVersion: spec.specVersion,
    sourceHash: sourceBundle.sourceHash, suiteVersion: 'synthetic-http-test-only', mode: 'development',
    status: status === 'validated' ? 'passed' : status,
    checks: ['compilation', 'staticAnalysis', 'clauseTests'].map(name => ({ name,
      status: name === 'compilation' || status === 'validated' ? 'passed' : status,
      findings: [] })), artifact: null };
  if (status === 'validated') {
    compiledFixture ??= compile(Object.fromEntries(Object.entries(sourceBundle.sources).map(([name, content]) => [name, { content }])))[sourceBundle.entryFile][sourceBundle.entryContract];
    // Real compiled bytes, but the passed report is an injected fixture, not validator evidence.
    validationReport.artifact = { abi: compiledFixture.abi, bytecode: '0x' + compiledFixture.evm.bytecode.object,
      compilerVersion: sourceBundle.compilerVersion, buildSettings: sourceBundle.buildSettings,
      sourceHash: sourceBundle.sourceHash, constructorTypes: ['address', 'address', 'uint256[]'] };
  }
  return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [],
    result: { status, sourceBundle, validationReport,
      attempts: [{ attempt: 0, sourceHash: sourceBundle.sourceHash, reportId, feedbackUsed: [] }] } };
}
function controlledWorker() {
  const calls = [];
  return { calls, runner: (request, options) => new Promise((resolve, reject) => calls.push({ request, options, resolve, reject })) };
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + path, { method, ...(data === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: r.status, body: await r.json() };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return { call, close, port: server.address().port };
}
async function withAPI(generation, run, operations, savedGeneration) {
  const { call, close } = await listen(await createServer({ generation, operations, savedGeneration }));
  try {
    const accounts = (await call('/local-accounts')).body;
    const draft = { name: 'HTTP generation', clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones: [{ title: 'Homepage', amountWei: '3000000000000001' }, { title: 'Full site', amountWei: '7000000000000002' }] };
    const created = await call('/projects', draft);
    assert.equal(created.status, 201);
    await run({ call, draft, project: created.body, path: `/projects/${created.body.id}` });
  } finally { await close(); }
}
async function withPersistentAPI(options, run) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'local-escrow-persistence-'));
  let api, port = 0;
  async function restart() {
    if (api) await api.close();
    api = null;
    api = await listen(await createServer({ ...options, stateDirectory }), port);
    port = api.port;
    return api.call;
  }
  try { await run(await restart(), restart); }
  finally {
    if (api) await api.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}
async function confirm(call, path, specVersion = 1) {
  const response = await call(path + '/confirmation', { specVersion, approved: true });
  assert.equal(response.status, 200);
  return response.body.confirmation;
}
function startBody(confirmation, idempotencyKey = 'test-attempt-001') {
  return { specVersion: confirmation.specVersion, confirmationId: confirmation.confirmationId, idempotencyKey };
}
function archivedGeneration() {
  const request = structuredClone(require('../shared/examples/generate.request.json'));
  request.requestId = 'agent2-direct';
  const { spec, confirmation } = request.payload;
  spec.projectId = confirmation.projectId = 'fc600cd3-fa0a-4b32-9e78-239285741306';
  spec.specVersion = confirmation.specVersion = 2;
  confirmation.confirmationId = 'e5595dc9-e852-48d0-a96e-56a2fc7aa391';
  request.payload.runConfig = { ...RUN_CONFIG };
  return { request, response: envelope(request, 'validated') };
}
async function finished(call, path, id) {
  const deadline = Date.now() + 10000;
  do {
    const r = await call(`${path}/generation-runs/${id}`);
    assert.equal(r.status, 200);
    if (r.body.finishedAt) return r.body;
    await pause(10);
  } while (Date.now() < deadline);
  assert.fail('Generation did not settle within test deadline');
}

test('generation HTTP requires explicit current confirmation and rejects caller-selected execution fields', async () => {
  const worker = controlledWorker();
  await withAPI({ enabled: true, runner: worker.runner }, async ({ call, path, project }) => {
    const context = (await call(path + '/agreement')).body;
    assert.equal(context.confirmation, null);
    assert.equal(context.spec.specVersion, 1);
    assert.equal(context.spec.totalAmountWei, '10000000000000003');
    assert.deepEqual(context.spec.milestones.map(m => m.id), [1, 2]);
    assert.equal('paid' in context.spec.milestones[0], false);
    assert.equal('contractAddress' in context.spec, false);
    assert.equal(context.spec.projectId, project.id);
    assert.equal(context.generatedDeploymentEnabled, true);
    assert.equal(context.deployment, null);
    for (const approved of [false, 'true', 1, null]) {
      assert.equal((await call(path + '/confirmation', { specVersion: 1, approved })).status, 400);
    }
    assert.equal((await call(path + '/confirmation', { specVersion: 2, approved: true })).status, 409);
    assert.equal((await call(path + '/confirmation', { specVersion: 1, approved: true, confirmationId: 'forged' })).status, 400);
    assert.equal((await call(path + '/generation-runs', { specVersion: 1, confirmationId: 'forged', idempotencyKey: 'test-001' })).status, 409);
    const confirmation = await confirm(call, path);
    assert.deepEqual(await confirm(call, path), confirmation);
    for (const extra of [{ runConfig: RUN_CONFIG }, { sourceBundle: bundleFixture }, { validationReport: {} }, { spec: context.spec }]) {
      assert.equal((await call(path + '/generation-runs', { ...startBody(confirmation), ...extra })).status, 400);
    }
    for (const specVersion of [0, '1', null]) {
      assert.equal((await call(path + '/generation-runs', { ...startBody(confirmation), specVersion })).status, 400);
    }
    assert.equal((await call(path + '/generation-runs', { ...startBody(confirmation), specVersion: 2 })).status, 409);
    assert.equal((await call(path + '/generation-runs', { ...startBody(confirmation), confirmationId: 'other' })).status, 409);
    assert.equal((await call(path + '/generation-runs', { ...startBody(confirmation), idempotencyKey: 'short' })).status, 400);
    assert.equal(worker.calls.length, 0);
  });
});

test('generation HTTP returns a run immediately, deduplicates clicks and never deploys a validated result', async () => {
  const worker = controlledWorker();
  await withAPI({ enabled: true, runner: worker.runner }, async ({ call, path, project }) => {
    const confirmation = await confirm(call, path);
    const body = startBody(confirmation);
    const started = await call(path + '/generation-runs', body);
    assert.equal(started.status, 202);
    assert.equal(started.body.status, 'running');
    assert.equal(started.body.result, null);
    const replay = await call(path + '/generation-runs', body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, started.body.id);
    assert.equal((await call(path + '/generation-runs', startBody(confirmation, 'different-key'))).status, 409);
    assert.equal((await call(path + '/generation-runs', { ...body, confirmationId: 'other' })).status, 409);
    assert.equal(worker.calls.length, 1);
    const { request, options, resolve } = worker.calls[0];
    assert.deepEqual(request.payload.runConfig, RUN_CONFIG);
    assert.deepEqual(request.payload.confirmation, confirmation);
    assert.equal(request.payload.spec.projectId, project.id);
    assert.equal(options.isCurrent(), true);
    // The worker's stages show on the run while it is in progress, and are gone once it ends.
    options.onProgress({ stage: 'repairing', attempt: 2, failedChecks: ['staticAnalysis'] });
    const running = (await call(path + '/generation-runs/' + started.body.id)).body;
    assert.equal(running.status, 'running');
    assert.deepEqual({ ...running.progress, at: undefined },
      { stage: 'repairing', attempt: 2, failedChecks: ['staticAnalysis'], maxAttempts: RUN_CONFIG.maxRepairs + 1, at: undefined });
    resolve(envelope(request, 'validated'));
    const result = await finished(call, path, started.body.id);
    assert.equal(result.progress, undefined);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.status, 'validated');
    assert.equal(result.generatedDeploymentEnabled, true);
    assert.equal((await call(path + '/agreement')).body.latestRunId, result.id);
    assert.deepEqual((await call(path)).body, project); // No transaction or project API field changes.
    assert.deepEqual((await call(path + '/generation-runs', body)).body, result);
    assert.equal(worker.calls.length, 1);
  });
});

test('editing rules invalidates confirmation and late results without releasing the running worker early', async () => {
  const worker = controlledWorker();
  await withAPI({ enabled: true, runner: worker.runner }, async ({ call, path, draft }) => {
    const oldConfirmation = await confirm(call, path);
    const oldRun = (await call(path + '/generation-runs', startBody(oldConfirmation))).body;
    const original = structuredClone(worker.calls[0].request.payload);
    const revised = { ...draft, milestones: [{ title: 'Only delivery', amountWei: '7' }] };
    const edited = await call(path + '/terms', { expectedSpecVersion: 1, draft: revised }, 'PUT');
    assert.equal(edited.status, 200);
    assert.equal(edited.body.spec.specVersion, 2);
    assert.equal(edited.body.spec.totalAmountWei, '7');
    assert.equal(edited.body.confirmation, null);
    assert.equal(edited.body.latestRunId, null);
    assert.equal(worker.calls[0].options.isCurrent(), false);
    assert.deepEqual(worker.calls[0].request.payload, original);
    assert.equal((await call(`${path}/generation-runs/${oldRun.id}`)).body.status, 'obsolete');
    assert.equal((await call(path + '/confirmation', { specVersion: 1, approved: true })).status, 409);
    const nextConfirmation = await confirm(call, path, 2);
    assert.notEqual(nextConfirmation.confirmationId, oldConfirmation.confirmationId);
    assert.equal((await call(path + '/generation-runs', startBody(nextConfirmation))).status, 409); // Reused key.
    assert.equal((await call(path + '/generation-runs', startBody(nextConfirmation, 'new-key-002'))).status, 409); // Old process active.
    worker.calls[0].resolve(envelope(worker.calls[0].request, 'validated'));
    const obsolete = await finished(call, path, oldRun.id);
    assert.equal(obsolete.status, 'obsolete');
    assert.equal(obsolete.result, null);
    const next = await call(path + '/generation-runs', startBody(nextConfirmation, 'new-key-002'));
    assert.equal(next.status, 202);
    assert.equal(worker.calls[1].request.payload.spec.totalAmountWei, '7');
    worker.calls[1].resolve(envelope(worker.calls[1].request));
    await finished(call, path, next.body.id);
    // Editing also invalidates a completed result, keeping it only as history.
    assert.equal((await call(path + '/terms', { expectedSpecVersion: 2, draft: revised }, 'PUT')).status, 200);
    const historical = (await call(`${path}/generation-runs/${next.body.id}`)).body;
    assert.equal(historical.status, 'obsolete');
    assert.equal(historical.result.status, 'failed');
  });
});

test('failed validation and toolError remain explicit outcomes, with no automatic retries', async () => {
  let calls = 0;
  await withAPI({ enabled: true, runner: async request => envelope(request, ++calls === 1 ? 'failed' : 'toolError') }, async ({ call, path }) => {
    const confirmation = await confirm(call, path);
    for (const status of ['failed', 'toolError']) {
      const started = await call(path + '/generation-runs', startBody(confirmation, `test-${status}`));
      assert.equal(started.status, 202);
      const run = await finished(call, path, started.body.id);
      assert.equal(run.status, 'completed');
      assert.equal(run.result.status, status);
      assert.equal(run.result.validationReport.artifact, null);
      assert.equal(run.error, null);
    }
    assert.equal(calls, 2);
  });
});

test('HTTP receiver rejects incomplete, stale, compilation-only and mismatched worker output', async () => {
  const variants = [
    response => { response.result = { status: 'validated' }; },
    response => { response.result.status = 'generated'; response.result.validationReport = null; response.result.attempts[0].reportId = null; },
    response => { response.result.validationReport.reportId = 'unrelated'; },
    response => { response.result.sourceBundle.specVersion += 1; },
    response => { response.status = 'error'; response.result = null; response.errors = [{ code: 'HANDOFF_ERROR', message: 'Worker problem', field: null }]; }
  ];
  let index = 0;
  await withAPI({ enabled: true, runner: async request => {
    const response = envelope(request); variants[index++](response); return response;
  } }, async ({ call, path }) => {
    const confirmation = await confirm(call, path);
    for (let i = 0; i < variants.length; i++) {
      const started = await call(path + '/generation-runs', startBody(confirmation, `invalid-result-${i}`));
      assert.equal(started.status, 202);
      const run = await finished(call, path, started.body.id);
      assert.equal(run.status, i === 3 ? 'obsolete' : 'error');
      assert.equal(run.result, null);
      if (i !== 3) assert.equal(run.error.code, 'GENERATION_TOOL_ERROR');
    }
    assert.equal(index, variants.length);
  });
});

test('worker timeout/crash is sanitized, deduplicated and permits a later explicit retry', async () => {
  let calls = 0;
  await withAPI({ enabled: true, runner: async request => {
    calls++;
    if (calls === 1) throw new Error('PYTHON_TIMEOUT');
    if (calls === 2) throw new Error('private diagnostic: DO_NOT_EXPOSE');
    return envelope(request);
  } }, async ({ call, path }) => {
    const confirmation = await confirm(call, path);
    for (const [i, code] of ['GENERATION_TIMEOUT', 'GENERATION_TOOL_ERROR'].entries()) {
      const body = startBody(confirmation, `error-test-${i}`);
      const started = await call(path + '/generation-runs', body);
      const run = await finished(call, path, started.body.id);
      assert.equal(run.status, 'error');
      assert.equal(run.error.code, code);
      assert.equal(JSON.stringify(run).includes('DO_NOT_EXPOSE'), false);
      assert.deepEqual((await call(path + '/generation-runs', body)).body, run);
    }
    const retry = await call(path + '/generation-runs', startBody(confirmation, 'explicit-retry'));
    assert.equal(retry.status, 202);
    assert.equal((await finished(call, path, retry.body.id)).status, 'completed');
    assert.equal(calls, 3);
  });
});

test('generation is disabled unless explicitly enabled; disabled requests never launch a worker', async () => {
  let calls = 0;
  const previous = process.env.AGENT2_MODE;
  delete process.env.AGENT2_MODE;
  try {
    await withAPI({ runner: async () => { calls++; } }, async ({ call, path }) => {
      assert.equal((await call(path + '/agreement')).body.generationEnabled, false);
      const confirmation = await confirm(call, path);
      assert.equal((await call(path + '/generation-runs', startBody(confirmation))).status, 503);
      assert.equal((await call(path + '/agreement')).body.latestRunId, null);
      assert.equal(calls, 0);
    });
  } finally { previous === undefined ? delete process.env.AGENT2_MODE : process.env.AGENT2_MODE = previous; }
});

test('term updates validate input/version and cannot change a deployed reference agreement', async () => {
  await withAPI({ enabled: true, runner: async request => envelope(request) }, async ({ call, path, draft, project }) => {
    const original = (await call(path + '/agreement')).body;
    for (const changed of [{ ...draft, milestones: [] }, { ...draft, totalAmountWei: '1' }, { ...draft, developerWallet: 'bad' },
      { ...draft, milestones: [{ title: 'Wrong', amountWei: '0' }] }]) {
      assert.equal((await call(path + '/terms', { expectedSpecVersion: 1, draft: changed }, 'PUT')).status, 400);
    }
    assert.equal((await call(path + '/terms', { expectedSpecVersion: 2, draft }, 'PUT')).status, 409);
    assert.deepEqual((await call(path + '/agreement')).body, original);
    assert.deepEqual((await call(path)).body, project);
    const confirmation = await confirm(call, path);
    assert.equal((await call(path + '/actions', { action: 'deploy' })).status, 200);
    assert.equal((await call(path + '/terms', { expectedSpecVersion: 1, draft }, 'PUT')).status, 409);
    assert.equal((await call(path + '/generation-runs', startBody(confirmation))).status, 409);
  });
});

test('run lookups are scoped to their project and unknown routes fail explicitly', async () => {
  await withAPI({ enabled: true, runner: async request => envelope(request) }, async ({ call, path, draft }) => {
    const confirmation = await confirm(call, path);
    const run = (await call(path + '/generation-runs', startBody(confirmation))).body;
    await finished(call, path, run.id);
    const second = (await call('/projects', draft)).body;
    assert.equal((await call(`/projects/${second.id}/generation-runs/${run.id}`)).status, 404);
    assert.equal((await call(`${path}/generation-runs/unknown`)).status, 404);
    assert.equal((await call('/projects/unknown/agreement')).status, 404);
    assert.equal((await call(path + '/agreement', {})).status, 405);
    assert.equal((await call(path + '/confirmation/extra')).status, 404);
  });
});

test('a confirmed generation deploys the report bytecode once, then Agent 3 operates that contract', async () => {
  const { runPython } = require('../backend/python-bridge.cjs');
  const { network } = require('hardhat');
  let action = 'deposit';
  const plans = [];
  const operations = { enabled: true, runner: async (request, options) => {
    if (request.operation === 'reportAction') return runPython(request, options);
    const { projectId, deployment } = request.payload;
    plans.push(deployment);
    return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [],
      result: { status: 'readyForConfirmation', question: null, summary: 'Test plan',
        intent: { projectId, chainId: deployment.chainId, contractAddress: deployment.contractAddress,
          action, milestoneId: action === 'acceptMilestone' ? 1 : null } } };
  } };
  await withAPI({ enabled: true, runner: async req => envelope(req, 'validated') }, async ({ call, path, draft }) => {
    const confirmation = await confirm(call, path);
    const run = (await call(path + '/generation-runs', startBody(confirmation))).body;
    const { result } = await finished(call, path, run.id);
    const url = path + '/generation-runs/' + run.id + '/deployment';
    const approval = { approved: true, specVersion: 1, confirmationId: confirmation.confirmationId };
    for (const invalid of [{ ...approval, approved: false }, { ...approval, bytecode: '0x00' }])
      assert.equal((await call(url, invalid)).status, 400);
    assert.equal((await call(url, { ...approval, confirmationId: 'different' })).status, 409);
    const initial = await call(url, approval);
    assert.equal(initial.status, 201);
    const address = initial.body.contractAddress;
    const receipt = initial.body.transactions[0];
    const artifact = result.validationReport.artifact;
    const { Interface } = require('ethers');
    const args = new Interface(artifact.abi).encodeDeploy([draft.clientWallet, draft.developerWallet,
      draft.milestones.map(m => BigInt(m.amountWei))]);
    const actual = await network.provider.send('eth_getTransactionByHash', [receipt.hash]);
    assert.equal(actual.input, artifact.bytecode + args.slice(2));
    assert.deepEqual((await call(path + '/agreement')).body.deployment,
      { kind: 'generated', runId: run.id, chainId: 31337, contractAddress: address,
        specVersion: 1, sourceHash: result.sourceBundle.sourceHash });
    const replay = await call(url, approval);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.transactions, initial.body.transactions);
    assert.equal((await call(path + '/actions', { action: 'deposit' })).status, 409);
    for (action of ['deposit', 'acceptMilestone']) {
      const plan = (await call(path + '/plans', { message: action })).body;
      const { status, body } = await call(path + '/plans/' + plan.planId + '/confirmation', { approved: true });
      assert.equal(status, 200);
      assert.equal(body.report.outcome, 'confirmed');
      assert.equal(body.project.contractAddress, address);
      assert.deepEqual(plans.at(-1).abi, artifact.abi);
      assert.equal(plans.at(-1).sourceHash, artifact.sourceHash);
      assert.equal(plans.at(-1).contractAddress, address);
      assert.equal(body.project.escrowBalanceWei, action === 'deposit' ? initial.body.totalAmountWei : draft.milestones[1].amountWei);
    }
    const known = await call(path + '/action-plans', { action: 'acceptMilestone', milestoneId: 2 });
    assert.equal(known.status, 200);
    assert.equal(known.body.intent.contractAddress, address);
    assert.equal(known.body.payment.amountWei, draft.milestones[1].amountWei);
    const finalPayment = await call(path + '/plans/' + known.body.planId + '/confirmation', { approved: true });
    assert.equal(finalPayment.body.report.outcome, 'confirmed');
    assert.equal(finalPayment.body.project.escrowBalanceWei, '0');
    assert.equal(finalPayment.body.project.milestones.every(m => m.paid), true);
    assert.equal(plans.length, 2); // The button plan did not call the model planner again.
  }, operations);
});

test('deployment rejects historical, foreign, failed and superseded runs', async () => {
  let resultStatus = 'validated';
  await withAPI({ enabled: true, runner: async req => envelope(req, resultStatus) }, async ({ call, path, draft }) => {
    const confirmation = await confirm(call, path);
    const approval = { approved: true, specVersion: 1, confirmationId: confirmation.confirmationId };
    const old = (await call(path + '/generation-runs', startBody(confirmation))).body;
    await finished(call, path, old.id);
    const url = (base, id) => base + '/generation-runs/' + id + '/deployment';
    const other = '/projects/' + (await call('/projects', draft)).body.id;
    assert.equal((await call(url(other, old.id), approval)).status, 404);
    resultStatus = 'failed';
    const next = (await call(path + '/generation-runs', startBody(confirmation, 'second-run'))).body;
    await finished(call, path, next.id);
    assert.equal((await call(path + '/generation-runs/' + old.id)).body.generatedDeploymentEnabled, false);
    assert.equal((await call(url(path, old.id), approval)).status, 409);
    assert.equal((await call(url(path, next.id), approval)).status, 409);
    await call(path + '/terms', { expectedSpecVersion: 1, draft }, 'PUT');
    assert.equal((await call(url(path, old.id), approval)).status, 409);
    assert.deepEqual((await call(path)).body.transactions, []);
  });
});

test('recovery restores checked terms on a fresh chain and requires approval to deploy exactly once', async () => {
  await require('hardhat').network.provider.send('hardhat_reset');
  const archive = archivedGeneration();
  const { spec, confirmation } = archive.request.payload;
  const path = '/projects/' + spec.projectId;
  const worker = controlledWorker();
  await withAPI({ enabled: true, runner: worker.runner }, async ({ call, draft }) => {
    const project = await call(path);
    assert.equal(project.status, 200);
    assert.equal(project.body.contractAddress, null);
    assert.equal(project.body.funded, false);
    assert.equal(project.body.escrowBalanceWei, '0');
    assert.deepEqual(project.body.transactions, []);
    const context = (await call(path + '/agreement')).body;
    assert.equal(context.recoveredOnFreshChain, true);
    assert.equal(context.draftOrigin, undefined);
    assert.deepEqual(context.spec, spec);
    assert.deepEqual(context.confirmation, confirmation);
    assert.equal(context.deployment, null);
    assert.ok(context.latestRunId);
    assert.notEqual(context.latestRunId, archive.request.requestId);
    const edit = await call(path + '/terms', { expectedSpecVersion: spec.specVersion, draft }, 'PUT');
    assert.equal(edit.status, 409);
    const runUrl = path + '/generation-runs/' + context.latestRunId;
    const run = await call(runUrl);
    assert.equal(run.status, 200);
    assert.equal(run.body.generatedDeploymentEnabled, true);
    assert.deepEqual(run.body.result, archive.response.result);
    const approval = { approved: true, specVersion: spec.specVersion, confirmationId: confirmation.confirmationId };
    const deployUrl = runUrl + '/deployment';
    assert.equal((await call(deployUrl, { ...approval, approved: false })).status, 400);
    assert.equal((await call(deployUrl, { ...approval, confirmationId: 'old-confirmation' })).status, 409);
    assert.deepEqual((await call(path)).body.transactions, []);
    const deployed = await call(deployUrl, approval);
    assert.equal(deployed.status, 201);
    assert.equal(deployed.body.transactions.length, 1);
    assert.equal(deployed.body.transactions[0].action, 'deploy');
    assert.equal(deployed.body.transactions[0].status, 1);
    const replay = await call(deployUrl, approval);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.transactions, deployed.body.transactions);
    const refreshed = (await call(path + '/agreement')).body;
    assert.equal(refreshed.recoveredOnFreshChain, true);
    assert.equal(refreshed.deployment.contractAddress, deployed.body.contractAddress);
    assert.equal(refreshed.deployment.runId, run.body.id);
    assert.equal(refreshed.deployment.sourceHash, archive.response.result.sourceBundle.sourceHash);
    assert.equal((await call(runUrl)).body.generatedDeploymentEnabled, false);
    assert.equal(worker.calls.length, 0);
  }, undefined, archive);
});

test('startup rejects failed checks, mismatched archives and substituted deployment bytecode', async () => {
  await require('hardhat').network.provider.send('hardhat_reset');
  for (const mutate of [
    a => { a.response = envelope(a.request, 'failed'); },
    a => { a.response.requestId = 'another-request'; },
    a => { a.request.payload.confirmation.specVersion++; },
    a => { a.request.payload.spec.totalAmountWei = '1'; },
    a => { a.response.result.validationReport.artifact.bytecode = '0x00'; }
  ]) {
    const archive = archivedGeneration();
    mutate(archive);
    await assert.rejects(createServer({ savedGeneration: archive }));
  }
});

test('HTTP to real Python bridge surfaces stub refusal without making a model call', async () => {
  const previous = process.env.AGENT2_MODE;
  process.env.AGENT2_MODE = 'stub';
  try {
    // Explicit test-only enablement; actual worker stays in stub mode and refuses C/3.
    await withAPI({ enabled: true }, async ({ call, path }) => {
      const confirmation = await confirm(call, path);
      const started = await call(path + '/generation-runs', startBody(confirmation));
      assert.equal(started.status, 202);
      const run = await finished(call, path, started.body.id);
      assert.equal(run.status, 'error');
      assert.equal(run.error.code, 'GENERATION_TOOL_ERROR');
      assert.equal(run.result, null);
    });
  } finally { previous === undefined ? delete process.env.AGENT2_MODE : process.env.AGENT2_MODE = previous; }
});

test('a normal restart restores the conversation, generation, deployed contract and paid milestone at their original URLs', async () => {
  const { spec: template } = require('../shared/examples/generate.request.json').payload;
  const clarificationCalls = [];
  let generationCalls = 0;
  const drafting = { enabled: true, runner: async request => {
    clarificationCalls.push(request.payload);
    const complete = request.payload.message === template.developerWallet;
    return { interfaceVersion: 1, requestId: request.requestId, status: 'ok', errors: [], result: {
      status: complete ? 'readyForConfirmation' : 'needsClarification', separateTerms: [], unsupportedTerms: [],
      questions: complete ? [] : [{ field: 'developerWallet', question: 'Which address receives the milestone payments?' }],
      draftSpec: { ...structuredClone(template), projectId: request.payload.draftSpec.projectId,
        developerWallet: complete ? template.developerWallet : null }
    } };
  } };
  const generation = { enabled: true, runner: async request => {
    generationCalls++;
    return envelope(request, 'validated');
  } };
  await withPersistentAPI({ drafting, generation }, async (call, restart) => {
    const draftPath = '/drafts/' + (await call('/drafts', {})).body.id;
    const message = { message: 'Build my website. Pay 30% for the homepage and 70% for the completed site.',
      expectedRevision: 0, requestKey: 'original-draft-message' };
    const first = await call(draftPath + '/messages', message);
    assert.equal(first.status, 200);

    call = await restart();
    assert.deepEqual((await call(draftPath)).body, first.body);
    assert.deepEqual((await call(draftPath + '/messages', message)).body, first.body);
    assert.equal(clarificationCalls.length, 1);
    const next = await call(draftPath + '/messages', { message: template.developerWallet,
      expectedRevision: first.body.revision, requestKey: 'provider-wallet-reply' });
    assert.equal(next.status, 200);
    assert.equal(next.body.result.status, 'readyForConfirmation');
    assert.deepEqual(clarificationCalls[1].history.filter(m => m.role === 'user').map(m => m.content), [message.message]);
    assert.deepEqual(JSON.parse(clarificationCalls[1].history.at(-1).content).question, first.body.turns[0].question);
    const confirmDraft = { approved: true, expectedRevision: next.body.revision };
    const confirmed = await call(draftPath + '/confirmation', confirmDraft);
    assert.equal(confirmed.status, 201);
    const path = '/projects/' + confirmed.body.project.id;
    const { confirmation } = confirmed.body.agreement;
    const start = startBody(confirmation);
    const started = await call(path + '/generation-runs', start);
    assert.equal(started.status, 202);
    const run = await finished(call, path, started.body.id);
    assert.equal(run.result.status, 'validated');
    const runPath = path + '/generation-runs/' + run.id;
    const approval = { approved: true, confirmationId: confirmation.confirmationId, specVersion: confirmation.specVersion };
    const deployed = await call(runPath + '/deployment', approval);
    assert.equal(deployed.status, 201);
    async function pay(action) {
      const plan = await call(path + '/action-plans', action);
      assert.equal(plan.status, 200);
      const result = await call(path + '/plans/' + plan.body.planId + '/confirmation', { approved: true });
      assert.equal(result.status, 200);
      assert.equal(result.body.report.outcome, 'confirmed');
      return result.body.project;
    }
    const funded = await pay({ action: 'deposit' });
    assert.equal(funded.escrowBalanceWei, template.totalAmountWei);
    const paid = await pay({ action: 'acceptMilestone', milestoneId: 1 });
    assert.deepEqual(paid.milestones.map(m => m.paid), [true, false]);
    assert.equal(paid.escrowBalanceWei, template.milestones[1].amountWei);
    assert.deepEqual(paid.transactions.map(tx => [tx.action, tx.status]), [['deploy', 1], ['deposit', 1], ['acceptMilestone', 1]]);
    const agreement = (await call(path + '/agreement')).body;
    const preview = await call(path + '/action-plans', { action: 'acceptMilestone', milestoneId: 2 });
    assert.equal(preview.status, 200);

    call = await restart();
    assert.deepEqual((await call(path)).body, paid);
    assert.deepEqual((await call(path + '/agreement')).body, agreement);
    assert.equal((await call(draftPath + '/confirmation', confirmDraft)).body.project.id, paid.id);
    assert.equal((await call(runPath)).body.result.validationReport.reportId, run.result.validationReport.reportId);
    const replay = await call(path + '/generation-runs', start);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, run.id);
    assert.equal(generationCalls, 1);
    assert.equal(clarificationCalls.length, 2);
    assert.equal((await call(runPath + '/deployment', approval)).status, 200);
    const stale = await call(path + '/plans/' + preview.body.planId + '/confirmation', { approved: true });
    assert.equal(stale.status, 404);
    assert.deepEqual((await call(path)).body.transactions, paid.transactions);
    const complete = await pay({ action: 'acceptMilestone', milestoneId: 2 });
    assert.equal(complete.contractAddress, deployed.body.contractAddress);
    assert.equal(complete.escrowBalanceWei, '0');
    assert.deepEqual(complete.transactions.slice(0, -1), paid.transactions);
    assert.equal(complete.transactions.at(-1).blockNumber, paid.transactions.at(-1).blockNumber + 1);
  });
});

test('a generation interrupted by restart keeps its run ID and requires an explicit new request to run again', async () => {
  const worker = controlledWorker();
  await withPersistentAPI({ generation: { enabled: true, runner: worker.runner } }, async (call, restart) => {
    const { spec } = require('../shared/examples/generate.request.json').payload;
    const draft = { name: spec.name, clientWallet: spec.clientWallet, developerWallet: spec.developerWallet,
      milestones: spec.milestones.map(({ title, amountWei }) => ({ title, amountWei })) };
    const created = await call('/projects', draft);
    assert.equal(created.status, 201);
    const path = '/projects/' + created.body.id;
    const confirmation = await confirm(call, path);
    const body = startBody(confirmation);
    const started = await call(path + '/generation-runs', body);
    assert.equal(started.status, 202);
    assert.equal(worker.calls.length, 1);

    call = await restart();
    const interrupted = await finished(call, path, started.body.id);
    assert.equal(interrupted.status, 'error');
    assert.equal(interrupted.error.code, 'GENERATION_INTERRUPTED');
    assert.equal(interrupted.generatedDeploymentEnabled, false);
    const replay = await call(path + '/generation-runs', body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, started.body.id);
    assert.equal(replay.body.error.code, 'GENERATION_INTERRUPTED');
    assert.equal(worker.calls.length, 1);
    const explicit = await call(path + '/generation-runs', startBody(confirmation, 'explicit-second-generation'));
    assert.equal(explicit.status, 202);
    assert.notEqual(explicit.body.id, started.body.id);
    worker.calls[1].resolve(envelope(worker.calls[1].request, 'validated'));
    assert.equal((await finished(call, path, explicit.body.id)).generatedDeploymentEnabled, true);
    assert.equal(worker.calls.length, 2);
  });
});

test('reopening the local ledger preserves wallet balances, transaction fees and the original receipt', async () => {
  const { openLocalChain } = require('../backend/local-chain.cjs');
  const original = await openLocalChain();
  const from = await original.provider.getSigner(0);
  const to = await (await original.provider.getSigner(1)).getAddress();
  const payer = await from.getAddress();
  const sent = await from.sendTransaction({ to, value: 1000n });
  const receipt = await sent.wait();
  await original.captureMined(receipt);
  const saved = original.chainState();
  const restored = await openLocalChain(saved);
  const read = provider => Promise.all([provider.getBalance(payer), provider.getBalance(to),
    provider.getTransactionCount(payer), provider.getBlockNumber(),
    provider.send('eth_getTransactionReceipt', [sent.hash])]);
  assert.deepEqual(await read(restored.provider), await read(original.provider));
  assert.deepEqual(restored.chainState(), saved);
  const corrupt = structuredClone(saved);
  corrupt.blocks[0].hash = '0x' + '0'.repeat(64);
  await assert.rejects(openLocalChain(corrupt), /block/i);
});
