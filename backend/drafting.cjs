// Server-owned conversation and user confirmation. Models never create projects or approvals.
const { randomUUID } = require('node:crypto');
const { runPython } = require('./python-bridge.cjs');
const { validateResponse } = require('../shared/handoff.cjs');
const { fields } = require('./generation.cjs');
const copy = x => structuredClone(x);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function eth(wei) {
  const digits = wei.padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return digits.slice(0, -18) + (fraction ? '.' + fraction : '') + ' ETH';
}
function questionPriority(field) {
  if (field === 'totalAmountWei') return 10;
  if (/^milestones\.\d+\.amountWei$/.test(field)) return 20;
  if (field === 'milestones' || /^milestones\./.test(field)) return 30;
  if (field === 'clientWallet') return 80;
  if (field === 'developerWallet') return 81;
  if (field === 'name') return 90;
  return 40;
}
function primaryQuestion(result) {
  if (result.unsupportedTerms.length) return { field: 'unsupportedTerms.0',
    question: `The current contract cannot enforce "${result.unsupportedTerms[0]}". Should this remain a draft, or have both parties agreed a replacement?` };
  const q = [...result.questions].sort((a, b) => questionPriority(a.field) - questionPriority(b.field)
    || a.field.localeCompare(b.field, 'en', { numeric: true }))[0];
  if (!q) return null;
  const fixed = {
    totalAmountWei: 'What total amount in ETH have both parties agreed?',
    clientWallet: 'What wallet address will the client use to fund the contract?',
    developerWallet: 'What wallet address will receive the provider’s milestone payments?',
    milestones: 'Which deliverables should be accepted, in payment order?',
    name: 'What is the project called?',
    approvalRole: 'Who do both parties agree may approve each milestone payment?',
  };
  const stage = /^milestones\.(\d+)\.(amountWei|title)$/.exec(q.field);
  let text = fixed[q.field];
  if (stage) text = stage[2] === 'amountWei'
    ? `What amount in ETH, or percentage of the total, is payable for milestone ${stage[1]}?`
    : `What must be delivered for milestone ${stage[1]}?`;
  if (!text) {
    // The extraction prompt requests one focused question per field. Keep only its first question
    // for display; all underlying blockers remain in result.questions and block confirmation.
    text = q.question.match(/^[\s\S]*?[\uFF1F?]/)?.[0] ?? q.question;
  }
  return { field: q.field, question: text };
}
function conversationTurn(previous, result, revision) {
  const before = previous?.draftSpec, after = result.draftSpec, lines = [];
  if (after.name !== 'Untitled project' && after.name !== before?.name)
    lines.push(`Project recorded: ${after.name}.`);
  if (after.totalAmountWei !== before?.totalAmountWei && after.totalAmountWei)
    lines.push(`The total is recorded as ${eth(after.totalAmountWei)}.`);
  if (JSON.stringify(after.milestones) !== JSON.stringify(before?.milestones ?? []) && after.milestones.length) {
    const amounts = after.milestones.map(m => m.amountWei ? eth(m.amountWei) : 'amount unresolved');
    lines.push(`Recorded ${after.milestones.length} delivery milestones, with payments of ${amounts.join(', ')} in order.`);
  }
  for (const [field, label] of [['clientWallet', 'client funding address'],
    ['developerWallet', 'provider payment address']]) {
    if (after[field] !== before?.[field] && after[field])
      lines.push(`The ${label} is recorded.`);
  }
  if (JSON.stringify(result.separateTerms ?? []) !== JSON.stringify(previous?.separateTerms ?? []))
    lines.push(`Separate written terms now contain ${(result.separateTerms ?? []).length} items; they are outside the on-chain payment rules.`);
  if (!lines.length) lines.push('Your latest message is recorded.');
  if (result.status === 'readyForConfirmation') lines.push('The payment rules are complete. Review the summary before explicitly confirming.');
  else if (result.status === 'unsupported') lines.push('Some terms remain outside the current contract’s capabilities, so the draft cannot be confirmed yet.');
  return { revision, reply: lines.join(' '), question: primaryQuestion(result) };
}

function createDrafting({ runner = runPython, enabled = process.env.AGENT1_MODE === 'live' } = {}) {
  const sessions = new Map();
  function create(body) {
    fields(body, []);
    const id = randomUUID(), now = new Date().toISOString();
    const s = { id, revision: 0, createdAt: now, updatedAt: now, messages: [], turns: [], result: null,
      busy: false, confirmedProjectId: null, pendingMessage: null, lastError: null, history: [], keys: new Map() };
    sessions.set(id, s);
    return snapshot(s);
  }
  function state(id) {
    const s = sessions.get(id);
    if (!s) fail(404, 'Draft not found. Local drafts reset when the backend restarts.');
    return s;
  }
  function snapshot(s) {
    const { history, keys, ...visible } = s;
    return copy(visible);
  }
  function revision(s, expected) {
    if (!Number.isSafeInteger(expected) || expected < 0) fail(400, 'expectedRevision must be a nonnegative integer');
    if (expected !== s.revision) fail(409, 'Draft changed. Reload it before continuing.');
  }
  async function message(id, body) {
    fields(body, ['message', 'expectedRevision', 'requestKey']);
    const s = state(id);
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 20000) fail(400, 'Enter a message of 1–20000 characters');
    if (typeof body.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestKey)) fail(400, 'Invalid requestKey');
    const prior = s.keys.get(body.requestKey);
    if (prior) {
      if (prior.message !== body.message || prior.revision !== body.expectedRevision) fail(409, 'This request key belongs to a different message');
      // A lost HTTP response can be recovered without another model call.
      return snapshot(s);
    }
    if (!enabled) fail(503, 'Agreement assistant is disabled. Start the backend with AGENT1_MODE=live.');
    revision(s, body.expectedRevision);
    if (s.confirmedProjectId) fail(409, 'This draft is confirmed. Start a new agreement to change its terms.');
    if (s.busy) fail(409, 'A reply is still being prepared. Wait before sending another message.');
    if (s.pendingMessage && (s.pendingMessage.content !== body.message || s.pendingMessage.requestKey !== body.requestKey))
      fail(409, 'Retry the previous message before changing this agreement, or start a new draft.');
    const seed = s.result?.draftSpec ?? { schemaVersion: 1, projectId: s.id, specVersion: 1,
      name: 'Untitled project', clientWallet: null, developerWallet: null, milestones: [],
      totalAmountWei: null, approvalRole: 'client', refundPolicy: 'none', deadline: null };
    const request = { interfaceVersion: 1, requestId: randomUUID(), operation: 'clarify',
      payload: { message: body.message, history: copy(s.history), draftSpec: copy(seed) } };
    // Bound the conversation before the worker starts; the bridge also limits IO.
    if (Buffer.byteLength(JSON.stringify(request)) > 512 * 1024) fail(413, 'This conversation is too long. Start a new draft with a shorter agreement.');
    s.pendingMessage = { content: body.message, requestKey: body.requestKey, expectedRevision: body.expectedRevision };
    s.lastError = null;
    s.busy = true;
    try {
      const response = await runner(request);
      validateResponse(request, response);
      if (response.status !== 'ok') throw new Error('CLARIFICATION_REJECTED');
      const result = copy(response.result);
      s.revision += 1;
      // Node assigns authoritative session identity and revision, never the model.
      result.draftSpec.projectId = s.id;
      result.draftSpec.specVersion = s.revision;
      const turn = conversationTurn(s.result, result, s.revision);
      s.turns.push(turn);
      s.result = result;
      s.messages.push({ role: 'user', content: body.message });
      s.history.push({ role: 'user', content: body.message },
        { role: 'assistant', content: JSON.stringify({ result, separateTerms: result.separateTerms ?? [], question: turn.question }) });
      s.updatedAt = new Date().toISOString();
      s.keys.set(body.requestKey, { message: body.message, revision: body.expectedRevision });
      s.pendingMessage = null;
    } catch {
      s.lastError = 'The agreement assistant could not finish. Your previous draft is unchanged and cannot be confirmed until this message is resolved. Retry this message.';
      fail(502, s.lastError);
    } finally { s.busy = false; }
    return snapshot(s);
  }
  function confirmationCandidate(id, body) {
    fields(body, ['approved', 'expectedRevision']);
    const s = state(id);
    if (body.approved !== true) fail(400, 'Explicit approval is required');
    revision(s, body.expectedRevision);
    if (s.busy) fail(409, 'Wait for the current reply before confirming');
    if (s.pendingMessage) fail(409, 'Resolve the last message before confirming the agreement');
    if (!s.result || s.result.status !== 'readyForConfirmation' || s.result.questions.length || s.result.unsupportedTerms.length)
      fail(409, 'Resolve the outstanding questions and unsupported terms before confirming');
    return { spec: copy(s.result.draftSpec), projectId: s.confirmedProjectId };
  }
  function markConfirmed(id, projectId) { state(id).confirmedProjectId = projectId; }
  function get(id) { return snapshot(state(id)); }
  return { enabled, create, get, message, confirmationCandidate, markConfirmed };
}
module.exports = { createDrafting };
