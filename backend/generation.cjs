// Trusted HTTP orchestration. No signing and no client-selected model/config/source.
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { runPython } = require('./python-bridge.cjs');
const { validateResponse } = require('../shared/handoff.cjs');
// AGENT2_MODEL names a model served at AGENT2_BASE_URL (for example a local fine-tuned model);
// set both in the launch environment. Without them the pinned hosted model is used.
const RUN_CONFIG = Object.freeze({ validationMode: 'development', maxRepairs: 3,
  feedbackSetting: 'C', model: process.env.AGENT2_MODEL || 'gpt-5.4-mini-2026-03-17' });
const copy = value => structuredClone(value);
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function fields(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(body, key))) {
    fail(400, `Expected only: ${names.join(', ')}`);
  }
}
function specFromProject(p, specVersion) {
  return { schemaVersion: 1, projectId: p.id, specVersion, name: p.name,
    clientWallet: p.clientWallet, developerWallet: p.developerWallet,
    milestones: p.milestones.map(m => ({ id: m.id, title: m.title, amountWei: m.amountWei })),
    totalAmountWei: p.totalAmountWei, approvalRole: 'client', refundPolicy: 'none', deadline: null,
    ...(p.reviewPeriodSeconds ? { reviewPeriodSeconds: p.reviewPeriodSeconds, changeRequestLimit: p.changeRequestLimit ?? 0 } : {}) };
}
function createGeneration({ runner = runPython, enabled = process.env.AGENT2_MODE === 'live',
  saved, onChange = () => {} } = {}) {
  const agreements = new Map(saved?.agreements), runs = new Map(saved?.runs), keys = new Map(saved?.keys), active = new Map();
  for (const run of runs.values()) {
    if (run.finishedAt === null) {
      if (run.status === 'running') {
        run.status = 'error';
        run.error = { code: 'GENERATION_INTERRUPTED', message: 'Generation was interrupted when the backend stopped. Start another run only if you want to retry.' };
      }
      run.finishedAt = new Date().toISOString();
    }
  }
  function exportState() { return { agreements: [...agreements], runs: [...runs], keys: [...keys] }; }
  function state(p) {
    if (!agreements.has(p.id)) agreements.set(p.id, { spec: specFromProject(p, 1), confirmation: null, latestRunId: null });
    return agreements.get(p.id);
  }
  function context(p) {
    return copy({ interfaceVersion: 1, ...state(p), generationEnabled: enabled, generatedDeploymentEnabled: true });
  }
  function version(s, value) {
    if (!Number.isInteger(value) || value < 1) fail(400, 'specVersion must be a positive integer');
    if (s.spec.specVersion !== value) fail(409, 'Agreement changed; reload and review the current rules');
  }
  function confirm(p, body) {
    fields(body, ['specVersion', 'approved']);
    if (body.approved !== true) fail(400, 'Explicit approval is required');
    const s = state(p); version(s, body.specVersion);
    // Retrying confirmation of unchanged terms does not invalidate an existing run.
    if (!s.confirmation) s.confirmation = { projectId: p.id, specVersion: s.spec.specVersion,
      confirmationId: randomUUID(), confirmedAt: new Date().toISOString() };
    return context(p);
  }
  function replaceTerms(p, terms, expectedSpecVersion) {
    const s = state(p); version(s, expectedSpecVersion);
    if (p.contractAddress) fail(409, 'Deployed agreements cannot be edited; create a new project');
    Object.assign(p, copy(terms));
    s.spec = specFromProject(p, s.spec.specVersion + 1);
    s.confirmation = null;
    s.latestRunId = null;
    for (const run of runs.values()) if (run.projectId === p.id && run.specVersion !== s.spec.specVersion) {
      run.status = 'obsolete';
      // Retain an earlier result as history, never as approval for the new version.
    }
    return context(p);
  }
  function getRun(p, id) {
    const run = runs.get(id);
    if (!run || run.projectId !== p.id) fail(404, 'Generation run not found');
    return copy({ ...run, generatedDeploymentEnabled: !p.contractAddress && isDeployable(state(p), run) });
  }
  function isDeployable(s, run) {
    return s.latestRunId === run.id && run.specVersion === s.spec.specVersion &&
      run.confirmationId === s.confirmation?.confirmationId && run.status === 'completed' &&
      run.result?.status === 'validated' && run.result.validationReport?.status === 'passed' &&
      Boolean(run.result.validationReport.artifact);
  }
  // Startup only. The server verifies the archive before constructing the corresponding project.
  function restore(p, { request, response }) {
    const { spec, confirmation } = request.payload;
    if (agreements.has(p.id) || !isDeepStrictEqual(spec, specFromProject(p, spec.specVersion)))
      throw new Error('Saved agreement does not match the local project and accounts.');
    const runId = randomUUID(), recoveredAt = new Date().toISOString();
    const s = { spec: copy(spec), confirmation: copy(confirmation), latestRunId: runId };
    const run = { schemaVersion: 1, id: runId, projectId: p.id, specVersion: spec.specVersion,
      confirmationId: confirmation.confirmationId, status: 'completed', error: null, result: copy(response.result),
      createdAt: recoveredAt, finishedAt: recoveredAt };
    if (!isDeployable(s, run)) throw new Error('The saved contract is ineligible for deployment.');
    agreements.set(p.id, s);
    runs.set(runId, run);
  }
  function deploymentCandidate(p, id, body) {
    fields(body, ['approved', 'specVersion', 'confirmationId']);
    if (body.approved !== true) fail(400, 'Explicit deployment approval is required');
    const s = state(p);
    version(s, body.specVersion);
    const run = runs.get(id);
    if (!run || run.projectId !== p.id) fail(404, 'Generation run not found');
    if (body.confirmationId !== s.confirmation?.confirmationId || !isDeployable(s, run))
      fail(409, 'Deployment requires the latest independently validated run for these confirmed rules');
    // The stored response passed the worker boundary checks for source, report, build and attempts.
    return { artifact: run.result.validationReport.artifact, spec: s.spec };
  }
  function start(p, body) {
    fields(body, ['specVersion', 'confirmationId', 'idempotencyKey']);
    if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.idempotencyKey)) fail(400, 'Invalid idempotencyKey');
    if (typeof body.confirmationId !== 'string' || !body.confirmationId) fail(400, 'Invalid confirmationId');
    const key = p.id + ':' + body.idempotencyKey;
    const replay = keys.get(key);
    if (replay) {
      if (replay.specVersion !== body.specVersion || replay.confirmationId !== body.confirmationId) fail(409, 'Idempotency key was used for different rules');
      return { replay: true, run: getRun(p, replay.id) };
    }
    if (!enabled) fail(503, 'AI generation is disabled; start the local backend with AGENT2_MODE=live to enable paid model calls');
    if (p.contractAddress) fail(409, 'Create a new project to generate a new contract; this reference project is already deployed');
    const s = state(p); version(s, body.specVersion);
    if (!s.confirmation || s.confirmation.confirmationId !== body.confirmationId) fail(409, 'Confirm the current agreement before generating');
    if (active.has(p.id)) fail(409, 'A generation is still running for this project');
    const id = randomUUID();
    const request = { interfaceVersion: 1, requestId: id, operation: 'generate', payload: {
      spec: copy(s.spec), confirmation: copy(s.confirmation), runConfig: { ...RUN_CONFIG } } };
    const run = { schemaVersion: 1, id, projectId: p.id, specVersion: s.spec.specVersion,
      confirmationId: s.confirmation.confirmationId, status: 'running', createdAt: new Date().toISOString(),
      finishedAt: null, result: null, error: null, generatedDeploymentEnabled: false };
    runs.set(id, run); keys.set(key, { id, specVersion: run.specVersion, confirmationId: run.confirmationId });
    active.set(p.id, id); s.latestRunId = id;
    onChange();
    const isCurrent = () => s.spec.specVersion === run.specVersion && s.confirmation?.confirmationId === run.confirmationId;
    // Return a run ID immediately. The browser polls; reloading never restarts a model call.
    Promise.resolve().then(async () => {
      try {
        // The worker reports each stage (writing, checking, repairing); the browser polls the run.
        const onProgress = progress => {
          if (run.status === 'running') run.progress = { ...progress, maxAttempts: RUN_CONFIG.maxRepairs + 1, at: new Date().toISOString() };
        };
        const response = await runner(request, { isCurrent, onProgress });
        validateResponse(request, response);
        if (!isCurrent()) { run.status = 'obsolete'; return; }
        if (response.status !== 'ok' || response.result.status === 'generated') throw new Error('INVALID_GENERATION_RESPONSE');
        run.result = copy(response.result);
        run.status = 'completed'; // Read result.status for the actual validation outcome.
      } catch (error) {
        if (!isCurrent() || error?.message === 'STALE_RESULT') run.status = 'obsolete';
        else {
          run.status = 'error';
          const timeout = error?.message === 'PYTHON_TIMEOUT';
          run.error = { code: timeout ? 'GENERATION_TIMEOUT' : 'GENERATION_TOOL_ERROR',
            message: timeout ? 'Generation timed out. Review this run before starting a new one.' : 'Generation could not complete. Check the local worker and tools before retrying.' };
        }
      } finally {
        delete run.progress;
        run.finishedAt = new Date().toISOString();
        if (active.get(p.id) === id) active.delete(p.id);
        onChange();
      }
    }).catch(() => { /* The store fences subsequent requests when a disk write fails. */ });
    return { replay: false, run: copy(run) };
  }
  return { context, confirm, replaceTerms, getRun, start, deploymentCandidate, restore, exportState };
}
module.exports = { createGeneration, fields, RUN_CONFIG };
