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

function createOperations({ runner = runPython, enabled = process.env.AGENT3_MODE === 'live', now = () => Date.now() } = {}) {
  const plans = new Map(); // One current plan per project; a new request replaces the earlier plan.
  function paymentDetails(intent, snapshot) {
    if (!intent || intent.action === 'query') return null;
    const milestone = snapshot.milestones.find(m => m.id === intent.milestoneId);
    if (intent.action === 'acceptMilestone' && !milestone) return null;
    const deposit = intent.action === 'deposit';
    return { amountWei: deposit ? snapshot.totalAmountWei : milestone.amountWei,
      from: deposit ? snapshot.clientWallet : snapshot.contractAddress,
      to: deposit ? snapshot.contractAddress : snapshot.developerWallet,
      milestoneTitle: deposit ? null : milestone.title };
  }
  function savePlan(p, result, language, snapshot) {
    const id = randomUUID();
    plans.set(p.id, { id, intent: copy(result.intent), used: false, createdAt: now(), language });
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
    const request = { interfaceVersion: 1, requestId: id, operation: 'planAction',
      payload: { message: body.message, projectId: p.id, deployment, snapshot } };
    let result;
    try { result = await ask(request, PLAN_TIMEOUT_MS); }
    catch (error) {
      if (error?.message === 'PROJECT_BUSY') fail(409, 'Another request is running for this project; retry after it completes');
      fail(502, 'Agent 3 could not answer. No transaction has been sent.');
    }
    return savePlan(p, result, /[一-鿿]/.test(body.message) ? 'zh' : 'en', snapshot);
  }
  // Buttons select a known operation. Amounts, recipients and contract identity always come from Node.
  function planKnown(p, body, deployment, snapshot) {
    if (!['deposit', 'acceptMilestone'].includes(body?.action)) fail(400, 'Choose a deposit or milestone acceptance');
    fields(body, body.action === 'deposit' ? ['action'] : ['action', 'milestoneId']);
    if (body.action === 'acceptMilestone' && (!Number.isInteger(body.milestoneId) || body.milestoneId < 1))
      fail(400, 'Choose a valid milestone');
    const intent = { projectId: p.id, chainId: deployment.chainId, contractAddress: deployment.contractAddress,
      action: body.action, milestoneId: body.action === 'deposit' ? null : body.milestoneId };
    recheck(p, { intent }, deployment.chainId, snapshot);
    const payment = paymentDetails(intent, snapshot);
    const chinese = /[一-鿿]/.test(p.name + snapshot.milestones.map(m => m.title).join(' '));
    const amount = formatEther(payment.amountWei);
    const summary = intent.action === 'deposit'
      ? (chinese ? `确认存入 ${amount} 测试 ETH 到托管合约。尚未发送交易。` : `Review a deposit of ${amount} test ETH into escrow. No transaction has been sent.`)
      : (chinese ? `确认已验收第 ${intent.milestoneId} 阶段「${payment.milestoneTitle}」，并支付 ${amount} 测试 ETH。尚未发送交易。`
        : `Confirm acceptance of milestone #${intent.milestoneId} "${payment.milestoneTitle}" and payment of ${amount} test ETH. No transaction has been sent.`);
    return savePlan(p, { status: 'readyForConfirmation', question: null, summary, intent }, chinese ? 'zh' : 'en', snapshot);
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
      const failed = receipt?.status === 0 && receiptOutcome(request.payload) === 'failed';
      const detail = receipt ? `Receipt status: ${receipt.status}, transaction ${receipt.hash}.` : 'No receipt is available yet.';
      return { outcome: failed ? 'failed' : 'unverified',
        summary: `The report service could not verify the result. ${detail} Check the transaction status before retrying.` };
    }
  }
  return { plan, planKnown, take, recheck, report, enabled };
}
module.exports = { createOperations };
