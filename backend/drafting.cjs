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
function milestoneLabel(spec, id) {
  const milestone = spec.milestones.find(m => m.id === Number(id));
  return `milestone ${id}${milestone?.title ? ` (\u201c${milestone.title}\u201d)` : ''}`;
}
function primaryQuestion(result) {
  if (result.unsupportedTerms.length) {
    const more = result.unsupportedTerms.length - 1;
    return { field: 'unsupportedTerms.0',
      question: `The contract can't enforce "${result.unsupportedTerms[0]}"${more ? ` or ${more} other term${more === 1 ? '' : 's'} listed in the summary` : ''} as written. How should ${more ? 'they' : 'it'} be handled? You can turn a term into something the contract supports (for example, a milestone the client approves), keep it in your separate written agreement, or leave this draft open. One reply can cover all of them.` };
  }
  const q = [...result.questions].sort((a, b) => questionPriority(a.field) - questionPriority(b.field)
    || a.field.localeCompare(b.field, 'en', { numeric: true }))[0];
  if (!q) return null;
  // Questions follow the agreement's currency: a bare "800" reply is then read in that currency.
  const rates = result.exchangeRates ?? [];
  const fiat = rates.length === 1 ? rates[0].currency : null;
  const inEth = !rates.length && Boolean(result.draftSpec.totalAmountWei || result.draftSpec.milestones.some(m => m.amountWei));
  const fixed = {
    totalAmountWei: fiat ? `What is the total price in ${fiat}?`
      : inEth ? 'What total amount in ETH have both parties agreed?'
        : 'What is the total price, and in which currency? For example "$1,200" or "8,000 元".',
    clientWallet: 'What wallet address will the client use to fund the contract?',
    developerWallet: 'What wallet address will receive the provider’s milestone payments?',
    milestones: 'Which deliverables should be accepted, in payment order?',
    name: 'What is the project called?',
    approvalRole: 'Who do both parties agree may approve each milestone payment?',
  };
  const stage = /^milestones\.(\d+)\.(amountWei|title)$/.exec(q.field);
  let text = fixed[q.field];
  const known = stage && result.draftSpec.milestones.find(m => String(m.id) === stage[1])?.amountWei;
  // A question about an amount that is already recorded is the model's own doubt: show its words.
  if (stage && !(stage[2] === 'amountWei' && known)) text = stage[2] !== 'amountWei'
    ? `What must be delivered for ${milestoneLabel(result.draftSpec, stage[1])}?`
    : fiat
      ? `How much is paid for ${milestoneLabel(result.draftSpec, stage[1])}? Give an amount in ${fiat}, or a share of the total such as "half".`
      : `What amount in ETH, or percentage of ${result.draftSpec.totalAmountWei ? `the agreed ${eth(result.draftSpec.totalAmountWei)} total` : 'the total'}, is payable for ${milestoneLabel(result.draftSpec, stage[1])}?`;
  if (!text) {
    // The extraction prompt requests one focused question per field. Keep only its first question
    // for display; all underlying blockers remain in result.questions and block confirmation.
    text = q.question.match(/^[\s\S]*?[\uFF1F?]/)?.[0] ?? q.question;
  }
  return { field: q.field, question: text };
}
const short = address => `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
// "1667.36" -> "1,667.36": the rate exactly as recorded, grouped for reading.
const grouped = value => { const [whole, part] = value.split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (part ? '.' + part : ''); };
function rateLine(rate) {
  const at = `1 test ETH = ${grouped(rate.unitsPerEth)} ${rate.currency}`;
  const when = rate.asOf ? ` at ${rate.asOf.slice(11, 16)} UTC` : '';
  if (rate.source === 'stated') return `Amounts in ${rate.currency} are converted at the rate you gave, ${at}.`;
  if (rate.source === 'reference') return `Amounts in ${rate.currency} are converted at a reference rate, ${at}, because no live rate was available. Tell me if you agreed a different rate.`;
  const label = rate.source === 'cached' ? 'the last available rate' : 'the live rate';
  return `Amounts in ${rate.currency} are converted to test ETH at ${label}, ${at}${rate.provider ? ` (${rate.provider}${when})` : ''}, rounded to 6 decimals. Tell me if you agreed a different rate.`;
}
function conversationTurn(previous, result, revision, previousTurn, demoWallets = null) {
  const before = previous?.draftSpec, after = result.draftSpec, lines = [];
  const question = primaryQuestion(result);
  // Amounts written in another currency are repeated in it: "0.39228 ETH (≈ 500 GBP)".
  const rate = (result.exchangeRates ?? []).length === 1 ? result.exchangeRates[0] : null;
  const amount = wei => rate
    ? `${eth(wei)} (\u2248 ${(Number(BigInt(wei) / 10n ** 12n) / 1e6 * Number(rate.unitsPerEth)).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${rate.currency})`
    : eth(wei);
  if (after.name !== 'Untitled project' && after.name !== before?.name)
    lines.push(`Project recorded: ${after.name}.`);
  if (after.totalAmountWei !== before?.totalAmountWei && after.totalAmountWei)
    lines.push(`The total is recorded as ${amount(after.totalAmountWei)}.`);
  if (JSON.stringify(after.milestones) !== JSON.stringify(before?.milestones ?? []) && after.milestones.length) {
    const scheduleChanged = JSON.stringify(after.milestones.map(m => [m.id, m.title]))
      !== JSON.stringify((before?.milestones ?? []).map(m => [m.id, m.title]));
    if (scheduleChanged)
      lines.push(`Recorded ${after.milestones.length} delivery milestone${after.milestones.length === 1 ? '' : 's'}: ${after.milestones.map(m => `${m.id}. ${m.title}`).join('; ')}.`);
    const missing = after.milestones.filter(m => !m.amountWei);
    if (!missing.length) {
      const equal = after.milestones.every(m => m.amountWei === after.milestones[0].amountWei);
      const matchesTotal = after.totalAmountWei && after.milestones.reduce((sum, m) => sum + BigInt(m.amountWei), 0n) === BigInt(after.totalAmountWei);
      lines.push(equal && matchesTotal
        ? (after.milestones.length === 1
          ? `1 milestone of ${amount(after.milestones[0].amountWei)}, the full total.`
          : `${after.milestones.length} milestones at ${amount(after.milestones[0].amountWei)} each, for a total of ${amount(after.totalAmountWei)}.`)
        : `The milestone payments are ${after.milestones.map(m => amount(m.amountWei)).join(', ')} in order.`);
    }
    else {
      const known = after.milestones.filter(m => m.amountWei);
      if (known.length) lines.push(`Recorded payments: ${known.map(m => `${milestoneLabel(after, m.id)}: ${amount(m.amountWei)}`).join('; ')}.`);
      lines.push(missing.length === 1
        ? `An agreed payment amount is still needed for ${milestoneLabel(after, missing[0].id)}.`
        : `Agreed payment amounts are still needed for milestones ${missing.map(m => m.id).join(', ')}.`);
    }
  }
  for (const rate of result.exchangeRates ?? []) {
    const old = (previous?.exchangeRates ?? []).find(r => r.currency === rate.currency);
    if (!old || old.unitsPerEth !== rate.unitsPerEth || old.source !== rate.source) lines.push(rateLine(rate));
  }
  const demo = demoWallets && after.clientWallet === demoWallets.clientWallet && after.developerWallet === demoWallets.developerWallet;
  if (demo && (before?.clientWallet !== after.clientWallet || before?.developerWallet !== after.developerWallet))
    lines.push(`Payments use the built-in test accounts: the client pays from ${short(after.clientWallet)} and the provider is paid at ${short(after.developerWallet)}.`);
  else for (const [field, label] of [['clientWallet', 'client funding address'],
    ['developerWallet', 'provider payment address']]) {
    if (after[field] !== before?.[field] && after[field])
      lines.push(`The ${label} is recorded.`);
  }
  // Conditions the contract cannot enforce do not stop the user; say so once, plainly.
  const known = [...(previous?.notEnforced ?? []), ...(previous?.unsupportedTerms ?? [])];
  const moved = (result.notEnforced ?? []).filter(t => !known.includes(t));
  if (moved.length)
    lines.push(`The contract will not enforce ${moved.length === 1 ? 'this condition' : 'these conditions'}: ${moved.slice(0, 5).map(t => `\u201c${t}\u201d`).join('; ')}${moved.length > 5 ? ` and ${moved.length - 5} more` : ''}. ${moved.length === 1 ? 'It stays' : 'They stay'} in your written agreement and ${moved.length === 1 ? 'is' : 'are'} listed on the review page; each payment is released only when the client approves it.`);
  // Say what happened to terms the user dealt with, so they are not silently dropped.
  const cleared = (previous?.unsupportedTerms ?? []).filter(t => !result.unsupportedTerms.includes(t)
    && !(result.notEnforced ?? []).includes(t));
  if (cleared.length && cleared.length <= 5)
    lines.push(`${cleared.length === 1 ? 'This term no longer blocks' : 'These terms no longer block'} the draft: ${cleared.map(t => `\u201c${t}\u201d`).join('; ')}.`);
  else if (cleared.length)
    lines.push(`${cleared.length} terms no longer block the draft.`);
  const separate = (result.separateTerms ?? []).length;
  if (JSON.stringify(result.separateTerms ?? []) !== JSON.stringify(previous?.separateTerms ?? []))
    lines.push(`Separate written terms now contain ${separate} item${separate === 1 ? '' : 's'}; they are outside the on-chain payment rules.`);
  // A repeated question must explain what still blocks progress. Do not claim to have
  // accepted an amount merely because the user supplied a number or a model repeated it.
  if (question && question.field === previousTurn?.question?.field) {
    const stage = /^milestones\.(\d+)\.amountWei$/.exec(question.field);
    if (stage) lines.push(`The payment for ${milestoneLabel(after, stage[1])} is still open.`);
    else if (question.field === 'totalAmountWei')
      lines.push('The total price is still open; reply with the agreed amount, or say it is still undecided.');
  }
  if (!lines.length) lines.push(previousTurn?.question && previousTurn.question.field !== question?.field
    ? 'Noted. That answers the previous question.'
    : question
      ? 'The draft is unchanged. The question below still needs an answer before confirmation.'
      : 'The draft is unchanged.');
  if (result.status === 'readyForConfirmation') lines.push('The payment rules are complete. Review the summary before explicitly confirming.');
  else if (result.status === 'unsupported') lines.push('Some terms remain outside the current contract’s capabilities, so the draft cannot be confirmed yet.');
  return { revision, reply: lines.join(' '), question };
}

// In the local demo only the built-in test accounts can sign, so a first-time user is never asked
// for wallet addresses: empty wallet fields take those accounts.
function applyDemoWallets(result, demoWallets) {
  if (!demoWallets) return;
  const spec = result.draftSpec, wallets = ['clientWallet', 'developerWallet'];
  for (const field of wallets) if (!spec[field]) spec[field] = demoWallets[field];
  if (spec.clientWallet.toLowerCase() === spec.developerWallet.toLowerCase()) return;
  result.questions = result.questions.filter(q => !wallets.includes(q.field));
  if (result.status === 'needsClarification' && !result.questions.length && !result.unsupportedTerms.length)
    result.status = 'readyForConfirmation';
}
function createDrafting({ runner = runPython, enabled = process.env.AGENT1_MODE === 'live',
  saved = [], onChange = () => {}, demoWallets = null } = {}) {
  const sessions = new Map(saved.map(([id, data]) => [id, { ...data,
    busy: false, keys: new Map(data.keys),
    lastError: data.busy ? 'The backend restarted before this reply was recorded. Review the saved message before retrying.' : data.lastError }]));
  function exportState() {
    return Array.from(sessions, ([id, s]) => [id, { ...s, keys: [...s.keys] }]);
  }
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
    if (!s) fail(404, 'Draft not found in this local workspace.');
    return s;
  }
  // Conditions flagged on an earlier turn that no longer block the draft: the user replaced them
  // or kept them in the written agreement. The contract does not enforce them, so say so on review.
  function settledTerms(s) {
    const open = s.result?.unsupportedTerms ?? [], seen = [];
    for (const turn of s.history) {
      if (turn.role !== 'assistant') continue;
      let terms;
      try { terms = JSON.parse(turn.content)?.result?.unsupportedTerms; } catch { continue; }
      for (const term of Array.isArray(terms) ? terms : [])
        if (typeof term === 'string' && !open.includes(term) && !seen.includes(term)) seen.push(term);
    }
    return seen;
  }
  function snapshot(s) {
    const { history, keys, ...visible } = s;
    const settled = settledTerms(s);
    for (const term of s.result?.notEnforced ?? []) if (!settled.includes(term)) settled.push(term);
    return copy({ ...visible, settledTerms: settled });
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
      onChange();
      const response = await runner(request);
      validateResponse(request, response);
      if (response.status !== 'ok') throw new Error('CLARIFICATION_REJECTED');
      const result = copy(response.result);
      applyDemoWallets(result, demoWallets);
      s.revision += 1;
      // Node assigns authoritative session identity and revision, never the model.
      result.draftSpec.projectId = s.id;
      result.draftSpec.specVersion = s.revision;
      const turn = conversationTurn(s.result, result, s.revision, s.turns.at(-1), demoWallets);
      s.turns.push(turn);
      s.result = result;
      s.messages.push({ role: 'user', content: body.message });
      s.history.push({ role: 'user', content: body.message },
        { role: 'assistant', content: JSON.stringify({ result, separateTerms: result.separateTerms ?? [], reply: turn.reply, question: turn.question }) });
      s.updatedAt = new Date().toISOString();
      s.keys.set(body.requestKey, { message: body.message, revision: body.expectedRevision });
      s.pendingMessage = null;
    } catch {
      s.lastError = 'The agreement assistant could not finish. Your previous draft is unchanged and cannot be confirmed until this message is resolved. Retry this message.';
      fail(502, s.lastError);
    } finally { s.busy = false; onChange(); }
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
  // An unfinished conversation the user no longer wants. Confirmed drafts stay: projects point to them.
  function discard(id, body) {
    fields(body, []);
    const s = state(id);
    if (s.confirmedProjectId) fail(409, 'This agreement is confirmed. Its project keeps the conversation.');
    if (s.busy) fail(409, 'Wait for the current reply before discarding this conversation.');
    sessions.delete(id);
    onChange();
    return { id, discarded: true };
  }
  function get(id) { return snapshot(state(id)); }
  // Unconfirmed conversations, newest first, so a closed tab does not lose a draft.
  function list() {
    return [...sessions.values()]
      .filter(s => !s.confirmedProjectId && (s.messages.length || s.pendingMessage))
      .map(s => {
        const name = s.result?.draftSpec?.name;
        return { id: s.id, name: name && name !== 'Untitled project' ? name : null,
          createdAt: s.createdAt, updatedAt: s.updatedAt, status: s.result?.status ?? null,
          messageCount: s.messages.length, awaitingReply: s.busy || Boolean(s.pendingMessage) };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return { enabled, create, get, list, message, confirmationCandidate, markConfirmed, discard, exportState };
}
module.exports = { createDrafting };
