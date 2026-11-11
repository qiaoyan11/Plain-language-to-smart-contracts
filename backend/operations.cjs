// Agent 3 over HTTP. Node keeps the intent, checks the state again, executes, and reports from the receipt.
// Python only plans and words the report: it never signs, and the browser cannot change a stored intent.
const { randomUUID } = require('node:crypto');
const { runPython } = require('./python-bridge.cjs');
const { validateResponse } = require('../shared/handoff.cjs');
const { fields } = require('./generation.cjs');
const PLAN_TIMEOUT_MS = 12000, REPORT_TIMEOUT_MS = 10000, PLAN_TTL_MS = 10 * 60 * 1000, MAX_MESSAGE = 2000;
const copy = value => structuredClone(value);
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

function createOperations({ runner = runPython, enabled = process.env.AGENT3_MODE === 'live', now = () => Date.now() } = {}) {
  const plans = new Map(); // One current plan per project; a new request replaces the earlier plan.
  async function ask(request, timeoutMs) {
    const response = await runner(request, { timeoutMs });
    validateResponse(request, response);
    if (response.status !== 'ok') throw new Error('AGENT3_ERROR');
    return response.result;
  }
  async function plan(p, body, deployment, snapshot) {
    fields(body, ['message']);
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > MAX_MESSAGE) fail(400, `Message must contain 1–${MAX_MESSAGE} characters`);
    if (!enabled) fail(503, 'Agent 3 is disabled; start the local backend with AGENT3_MODE=live to enable paid model calls');
    const id = randomUUID();
    const request = { interfaceVersion: 1, requestId: id, operation: 'planAction',
      payload: { message: body.message, projectId: p.id, deployment, snapshot } };
    let result;
    try { result = await ask(request, PLAN_TIMEOUT_MS); }
    catch (error) {
      if (error?.message === 'PROJECT_BUSY') fail(409, 'Another request is running for this project; retry after it completes');
      fail(502, 'Agent 3 could not answer. No transaction has been sent.');
    }
    plans.set(p.id, { id, intent: copy(result.intent), used: false, createdAt: now(),
      language: /[一-鿿]/.test(body.message) ? 'zh' : 'en' });
    return { planId: id, status: result.status, question: result.question, summary: result.summary, intent: copy(result.intent) };
  }
  // Returns the stored plan for one execution. Call only when the signer is free.
  function take(p, planId, body) {
    fields(body, ['approved']);
    if (body.approved !== true) fail(400, 'Explicit approval is required');
    const stored = plans.get(p.id);
    if (!stored || stored.id !== planId) fail(404, 'Plan not found or replaced by a newer request');
    if (!stored.intent || stored.intent.action === 'query') fail(409, 'This plan has nothing to execute');
    if (stored.used) fail(409, 'This plan was already used; ask again');
    if (now() - stored.createdAt > PLAN_TTL_MS) fail(409, 'This plan expired; ask again');
    stored.used = true;
    return stored;
  }
  // The latest chain state must still allow the stored intent. The contract enforces the same rules again.
  function recheck(p, stored, chainId, snapshot) {
    const { intent } = stored, m = snapshot.milestones.find(x => x.id === intent.milestoneId);
    const sameContract = intent.projectId === p.id && intent.chainId === chainId && p.contractAddress &&
      intent.contractAddress.toLowerCase() === p.contractAddress.toLowerCase();
    const allowed = intent.action === 'deposit' ? !snapshot.funded
      : Boolean(m) && snapshot.funded && !m.paid && snapshot.milestones.every(x => x.id >= m.id || x.paid);
    if (!sameContract || !allowed) fail(409, 'The escrow state changed after this plan was made. No transaction has been sent; ask again.');
  }
  async function report(p, stored, receipt, snapshot) {
    const request = { interfaceVersion: 1, requestId: randomUUID(), operation: 'reportAction',
      payload: { projectId: p.id, intent: copy(stored.intent), receipt, snapshot, language: stored.language } };
    try { return await ask(request, REPORT_TIMEOUT_MS); }
    catch {
      // Never claim success without the checked report; show the raw receipt status instead.
      return { outcome: receipt?.status === 1 ? 'unverified' : 'failed',
        summary: `The report service did not answer. ${receipt ? `Receipt status: ${receipt.status}, transaction ${receipt.hash}.` : 'No transaction was confirmed.'} Check the project state.` };
    }
  }
  return { plan, take, recheck, report, enabled };
}
module.exports = { createOperations };
