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
// "1667.36" -> "1,667.36": the rate exactly as recorded, grouped for reading.
const grouped = value => { const [whole, part] = value.split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (part ? '.' + part : ''); };
function rateLine(rate) {
  const at = `1 test ETH = ${grouped(rate.unitsPerEth)} ${rate.currency}`;
  const when = rate.asOf ? ` ${rate.asOf.slice(11, 16)} UTC` : '';
  if (rate.source === 'stated') return `Rate: ${at}, as you stated.`;
  if (rate.source === 'reference') return `Rate: ${at}, a reference rate (no live rate was available). Tell me if you agreed a different one.`;
  const label = rate.source === 'cached' ? 'last available rate' : 'live rate';
  return `Rate: ${at} (${label}${rate.provider ? `, ${rate.provider}${when}` : ''}).`;
}
// One assistant turn: a one-line conclusion, then one short line per point, so the reply can be
// scanned. The payment summary beside the conversation holds the full detail.
function conversationTurn(previous, result, revision, previousTurn, demoWallets = null) {
  const before = previous?.draftSpec, after = result.draftSpec, lines = [];
  const question = primaryQuestion(result);
  const ready = result.status === 'readyForConfirmation';
  const rate = (result.exchangeRates ?? []).length === 1 ? result.exchangeRates[0] : null;
  // Cents by exact integer arithmetic, as the web page computes them. ETH amounts are rounded to
  // 6 decimals; within that rounding of a whole unit, show it whole.
  const local = wei => {
    const [whole = '0', fraction = ''] = rate.unitsPerEth.split('.');
    const scale = 10n ** BigInt(fraction.length), units = BigInt(whole + fraction), denominator = 10n ** 18n * scale;
    let cents = (BigInt(wei) * units * 100n + denominator / 2n) / denominator;
    const slack = units * 300n / (1000000n * scale), nearest = (cents + 50n) / 100n * 100n;
    if (cents - nearest <= slack && nearest - cents <= slack) cents = nearest;
    const part = cents % 100n;
    return (cents / 100n).toLocaleString('en-US') + (part ? '.' + part.toString().padStart(2, '0').replace(/0$/, '') : '');
  };
  // Amounts agreed in another currency lead with it: "500 GBP (0.39228 ETH)".
  const amount = wei => rate ? `${local(wei)} ${rate.currency} (${eth(wei)})` : eth(wei);
  const milestones = after.milestones, count = milestones.length;
  const missing = milestones.filter(m => !m.amountWei);
  const complete = count > 0 && !missing.length && after.totalAmountWei
    && milestones.reduce((sum, m) => sum + BigInt(m.amountWei), 0n) === BigInt(after.totalAmountWei);
  const equal = complete && milestones.every(m => m.amountWei === milestones[0].amountWei);
  const named = after.name !== 'Untitled project' && after.name !== before?.name;
  const totalChanged = Boolean(after.totalAmountWei) && after.totalAmountWei !== before?.totalAmountWei;
  const scheduleChanged = count > 0 && JSON.stringify(milestones) !== JSON.stringify(before?.milestones ?? []);
  if (named || totalChanged || scheduleChanged) {
    let line = after.name !== 'Untitled project' ? after.name : 'The agreement';
    if (after.totalAmountWei) line += `: ${amount(after.totalAmountWei)}`;
    if (complete) line += count === 1 ? ', paid in one milestone'
      : equal ? ` in ${count} equal payments of ${amount(milestones[0].amountWei)}` : ` in ${count} payments`;
    lines.push(ready ? `Ready for review — ${line}.` : `${line}.`);
  }
  if (scheduleChanged && !equal)
    for (const m of milestones)
      lines.push(`${m.id}. ${m.title}: ${m.amountWei ? amount(m.amountWei) : 'amount needed'}`);
  else if (scheduleChanged)
    lines.push(milestones.map(m => `${m.id}. ${m.title}`).join('; '));
  // v2 review period: say once when it is added, changed or removed.
  const period = after.reviewPeriodSeconds ?? null, limit = after.changeRequestLimit ?? 0;
  if (period !== (before?.reviewPeriodSeconds ?? null) || (period && limit !== (before?.changeRequestLimit ?? 0))) {
    const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const time = period >= 86400 ? unit(Math.round(period / 86400 * 10) / 10, 'day')
      : period >= 3600 ? unit(Math.round(period / 3600 * 10) / 10, 'hour') : unit(Math.round(period / 60), 'minute');
    if (period) lines.push(`Review: after each delivery the client has ${time} to approve or ask for changes${limit ? ` (up to ${unit(limit, 'time')})` : ''}. With no answer, the provider can claim the payment.`);
    else if (before?.reviewPeriodSeconds) lines.push('Automatic payment after review is off: the client approves every payment.');
  }
  for (const rate of result.exchangeRates ?? []) {
    const old = (previous?.exchangeRates ?? []).find(r => r.currency === rate.currency);
    if (!old || old.unitsPerEth !== rate.unitsPerEth || old.source !== rate.source) lines.push(rateLine(rate));
  }
  // The demo's built-in test accounts are named in the summary and the page banner, not here.
  const demo = demoWallets && after.clientWallet === demoWallets.clientWallet && after.developerWallet === demoWallets.developerWallet;
  if (!demo) for (const [field, label] of [['clientWallet', 'client funding address'],
    ['developerWallet', 'provider payment address']]) {
    if (after[field] !== before?.[field] && after[field])
      lines.push(`The ${label} is recorded.`);
  }
  // Conditions the contract cannot enforce do not stop the user; say so once, plainly.
  const known = [...(previous?.notEnforced ?? []), ...(previous?.unsupportedTerms ?? [])];
  const moved = (result.notEnforced ?? []).filter(t => !known.includes(t));
  if (moved.length)
    lines.push(`Not enforced by the contract: ${moved.slice(0, 3).map(t => `“${t}”`).join('; ')}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}.`);
  // Say what happened to terms the user dealt with, so they are not silently dropped.
  const cleared = (previous?.unsupportedTerms ?? []).filter(t => !result.unsupportedTerms.includes(t)
    && !(result.notEnforced ?? []).includes(t));
  if (cleared.length && cleared.length <= 5)
    lines.push(`No longer blocking: ${cleared.map(t => `“${t}”`).join('; ')}.`);
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
  if (ready) lines.push(lines[0].startsWith('Ready for review')
    ? 'Check the payment summary, then confirm.'
    : 'Ready for review: check the payment summary, then confirm.');
  else if (result.status === 'unsupported') lines.push('Some terms remain outside the current contract’s capabilities, so the draft cannot be confirmed yet.');
  return { revision, reply: lines.join('\n'), question };
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
