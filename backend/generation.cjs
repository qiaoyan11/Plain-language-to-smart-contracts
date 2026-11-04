// Trusted HTTP orchestration. No signing and no client-selected model/config/source.
const { randomUUID } = require('node:crypto');
const { runPython } = require('./python-bridge.cjs');
const { validateResponse } = require('../shared/handoff.cjs');
const RUN_CONFIG = Object.freeze({ validationMode: 'development', maxRepairs: 3,
  feedbackSetting: 'C', model: 'gpt-5.4-mini-2026-03-17' });
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
    totalAmountWei: p.totalAmountWei, approvalRole: 'client', refundPolicy: 'none', deadline: null };
}
function createGeneration({ runner = runPython, enabled = process.env.AGENT2_MODE === 'live' } = {}) {
  const agreements = new Map(), runs = new Map(), keys = new Map(), active = new Map();
  function state(p) {
    if (!agreements.has(p.id)) agreements.set(p.id, { spec: specFromProject(p, 1), confirmation: null, latestRunId: null });
    return agreements.get(p.id);
  }
  function context(p) {
    return copy({ interfaceVersion: 1, ...state(p), generationEnabled: enabled, generatedDeploymentEnabled: false });
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
    return copy(run);
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
    const isCurrent = () => s.spec.specVersion === run.specVersion && s.confirmation?.confirmationId === run.confirmationId;
    // Return a run ID immediately. The browser polls; reloading never restarts a model call.
    Promise.resolve().then(async () => {
      try {
        const response = await runner(request, { isCurrent });
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
        run.finishedAt = new Date().toISOString();
        if (active.get(p.id) === id) active.delete(p.id);
      }
    });
    return { replay: false, run: copy(run) };
  }
  return { context, confirm, replaceTerms, getRun, start };
}
module.exports = { createGeneration, fields, RUN_CONFIG };
