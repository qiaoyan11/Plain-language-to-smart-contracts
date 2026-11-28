// Agent 3 over HTTP. Node keeps the intent, checks the state again, executes, and reports from the receipt.
// Python only plans and words the report: it never signs, and the browser cannot change a stored intent.
const { randomUUID } = require('node:crypto');
const { formatEther } = require('ethers');
const { runPython } = require('./python-bridge.cjs');
const { validateResponse, receiptOutcome } = require('../shared/handoff.cjs');
const { fields } = require('./generation.cjs');
const PLAN_TIMEOUT_MS = 12000, REPORT_TIMEOUT_MS = 10000, PLAN_TTL_MS = 10 * 60 * 1000, MAX_MESSAGE = 2000;
const copy = value => structuredClone(value);
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

const KNOWN_ACTIONS = ['deposit', 'acceptMilestone', 'submitDelivery', 'requestChanges', 'claimMilestone'];
function createOperations({ runner = runPython, enabled = process.env.AGENT3_MODE === 'live', now = () => Date.now() } = {}) {
  const plans = new Map(); // One current plan per project; a new request replaces the earlier plan.
  // Money moves only on a deposit, an approval or a v2 claim; a delivery or a change request moves none.
  function paymentDetails(intent, snapshot) {
    if (!intent || !['deposit', 'acceptMilestone', 'claimMilestone'].includes(intent.action)) return null;
    const milestone = snapshot.milestones.find(m => m.id === intent.milestoneId);
    if (intent.action !== 'deposit' && !milestone) return null;
    const deposit = intent.action === 'deposit';
    return { amountWei: deposit ? snapshot.totalAmountWei : milestone.amountWei,
      from: deposit ? snapshot.clientWallet : snapshot.contractAddress,
      to: deposit ? snapshot.contractAddress : snapshot.developerWallet,
      milestoneTitle: deposit ? null : milestone.title };
  }
  function savePlan(p, result, snapshot, message = null) {
    const id = randomUUID();
    // A question from Agent 3 is remembered briefly, so a short reply ("yes", "the first one")
    // is read together with the request it answers.
    const pending = result.status === 'needsClarification' && message && result.question
      ? { message, question: result.question } : null;
    plans.set(p.id, { id, intent: copy(result.intent), used: false, createdAt: now(), pending });
    return { planId: id, status: result.status, question: result.question, summary: result.summary,
      intent: copy(result.intent), payment: paymentDetails(result.intent, snapshot) };
  }
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
    const previous = plans.get(p.id);
    const followUp = previous?.pending && now() - previous.createdAt < PLAN_TTL_MS
      && body.message.length <= 200 ? previous.pending : null;
    const message = followUp
      ? `${followUp.message}\n(Assistant asked: "${followUp.question}" The user replied: "${body.message}")`
      : body.message;
    const request = { interfaceVersion: 1, requestId: id, operation: 'planAction',
      payload: { message: message.slice(0, MAX_MESSAGE), projectId: p.id, deployment, snapshot } };
    let result;
    try { result = await ask(request, PLAN_TIMEOUT_MS); }
    catch (error) {
      if (error?.message === 'PROJECT_BUSY') fail(409, 'Another request is running for this project; retry after it completes');
      fail(502, 'Agent 3 could not answer. No transaction has been sent.');
    }
    return savePlan(p, result, snapshot, body.message);
  }
  // Buttons select a known operation. Amounts, recipients and contract identity always come from Node.
  function planKnown(p, body, deployment, snapshot) {
    const actions = snapshot.review ? KNOWN_ACTIONS : ['deposit', 'acceptMilestone'];
    if (!actions.includes(body?.action)) fail(400, 'Choose a deposit or a milestone action this contract supports');
    fields(body, body.action === 'deposit' ? ['action'] : ['action', 'milestoneId']);
    if (body.action !== 'deposit' && (!Number.isInteger(body.milestoneId) || body.milestoneId < 1))
      fail(400, 'Choose a valid milestone');
    const intent = { projectId: p.id, chainId: deployment.chainId, contractAddress: deployment.contractAddress,
      action: body.action, milestoneId: body.action === 'deposit' ? null : body.milestoneId };
    recheck(p, { intent }, deployment.chainId, snapshot);
    const payment = paymentDetails(intent, snapshot);
    const title = snapshot.milestones.find(m => m.id === intent.milestoneId)?.title;
    const period = snapshot.review?.periodSeconds ?? 0;
    const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const days = period >= 86400 ? unit(Math.round(period / 86400 * 10) / 10, 'day')
      : period >= 3600 ? unit(Math.round(period / 3600 * 10) / 10, 'hour') : unit(Math.round(period / 60), 'minute');
    const summary = {
      deposit: () => `Review a deposit of ${formatEther(payment.amountWei)} test ETH into escrow.`,
      acceptMilestone: () => `Confirm acceptance of milestone #${intent.milestoneId} "${title}" and payment of ${formatEther(payment.amountWei)} test ETH.`,
      claimMilestone: () => `Claim milestone #${intent.milestoneId} "${title}": its review period ended without a change request, so ${formatEther(payment.amountWei)} test ETH goes to the provider.`,
      submitDelivery: () => `Mark milestone #${intent.milestoneId} "${title}" as delivered. The client then has ${days} to approve it or ask for changes; after that the provider can claim the payment.`,
      requestChanges: () => `Ask for changes to milestone #${intent.milestoneId} "${title}". The delivery is withdrawn and the review starts again when the provider delivers again.`,
    }[intent.action]() + ' No transaction has been sent.';
    return savePlan(p, { status: 'readyForConfirmation', question: null, summary, intent }, snapshot);
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
    const next = Boolean(m) && snapshot.funded && !m.paid && snapshot.milestones.every(x => x.id >= m.id || x.paid);
    const time = snapshot.review?.chainTime ?? 0, ends = m?.deliveredAt ? m.deliveredAt + (snapshot.review?.periodSeconds ?? 0) : null;
    const limit = snapshot.review?.changeRequestLimit ?? 0;
    const allowed = {
      deposit: () => !snapshot.funded,
      acceptMilestone: () => next,
      submitDelivery: () => next && Boolean(snapshot.review) && !m.deliveredAt,
      requestChanges: () => next && ends !== null && time < ends && (limit === 0 || m.changeRequests < limit),
      claimMilestone: () => next && ends !== null && time >= ends,
    }[intent.action]?.() ?? false;
    if (!sameContract || !allowed) fail(409, 'The escrow state changed after this plan was made. No transaction has been sent; ask again.');
  }
  async function report(p, stored, receipt, snapshot) {
    const request = { interfaceVersion: 1, requestId: randomUUID(), operation: 'reportAction',
      payload: { projectId: p.id, intent: copy(stored.intent), receipt, snapshot, language: 'en' } };
    try { return await ask(request, REPORT_TIMEOUT_MS); }
    catch {
      const failed = receipt?.status === 0 && receiptOutcome(request.payload) === 'failed';
      const detail = receipt ? `Receipt status: ${receipt.status}, transaction ${receipt.hash}.` : 'No receipt is available yet.';
      return { outcome: failed ? 'failed' : 'unverified',
        summary: `The report service could not verify the result. ${detail} Check the transaction status before retrying.` };
    }
  }
  return { plan, planKnown, take, recheck, report, enabled };
}
module.exports = { createOperations };
