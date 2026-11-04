// HTTP integration tests with controlled worker responses: no paid model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: pause } = require('node:timers/promises');
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
async function withAPI(generation, run) {
  const server = await createServer({ generation });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + path, { method, ...(data === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const accounts = (await call('/local-accounts')).body;
    const draft = { name: 'HTTP generation', clientWallet: accounts.clientWallet, developerWallet: accounts.developerWallet,
      milestones: [{ title: 'Homepage', amountWei: '3000000000000001' }, { title: 'Full site', amountWei: '7000000000000002' }] };
    const created = await call('/projects', draft);
    assert.equal(created.status, 201);
    await run({ call, draft, project: created.body, path: `/projects/${created.body.id}` });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function confirm(call, path, specVersion = 1) {
  const response = await call(path + '/confirmation', { specVersion, approved: true });
  assert.equal(response.status, 200);
  return response.body.confirmation;
}
function startBody(confirmation, idempotencyKey = 'test-attempt-001') {
  return { specVersion: confirmation.specVersion, confirmationId: confirmation.confirmationId, idempotencyKey };
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
    assert.equal(context.generatedDeploymentEnabled, false);
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
    resolve(envelope(request, 'validated'));
    const result = await finished(call, path, started.body.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.status, 'validated');
    assert.equal(result.generatedDeploymentEnabled, false);
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
