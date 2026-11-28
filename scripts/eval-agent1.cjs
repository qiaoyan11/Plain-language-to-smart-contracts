// Replay everyday requests through the running local backend and score Agent 1.
//
//   npm run demo:live          (in another terminal)
//   npm run eval:agent1        (live model calls; each case costs one to three Agent 1 turns)
//
// For each case: did the draft reach confirmation, in how many turns, with the expected number
// of milestones and amounts? Amounts written in another currency are compared in that currency,
// using the rate the draft recorded, so a moving ETH price does not change the score. The same
// cases can later score a locally served Agent 1 model (AGENT1_BASE_URL) against the hosted one.
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const api = (process.env.LOCAL_API_URL || `http://127.0.0.1:${process.env.LOCAL_API_PORT || 3001}`) + '/api';
const cases = JSON.parse(readFileSync(join(root, 'agent1/cases/everyday.json'), 'utf8'));
const only = process.argv.slice(2);

async function call(path, body) {
  const response = await fetch(api + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data?.error ?? ''}`.trim());
  return data;
}

// Value of an amount in wei in the currency the user wrote, at the draft's recorded rate.
function original(wei, rate) {
  const eth = Number(BigInt(wei) / 10n ** 12n) / 1e6;
  return rate ? eth * Number(rate.unitsPerEth) : eth;
}
const close = (actual, expected) => Math.abs(actual - expected) <= Math.max(0.01, Math.abs(expected) * 0.0005);

function score(test, draft, turns) {
  const result = draft.result, problems = [];
  // Some requests cannot be represented (an open-ended hourly arrangement): they must not be confirmable.
  if (test.expect.ready === false)
    return result?.status === 'readyForConfirmation' ? ['reached confirmation, expected a question or a refusal'] : [];
  const rates = result?.exchangeRates ?? [];
  const rate = test.expect.currency === 'ETH' ? null : rates.find(r => r.currency === test.expect.currency);
  if (result?.status !== 'readyForConfirmation') problems.push(`status ${result?.status}`);
  if (test.expect.currency !== 'ETH' && !rate) problems.push(`no ${test.expect.currency} rate recorded`);
  const milestones = result?.draftSpec.milestones ?? [];
  if (test.expect.amounts && milestones.length !== test.expect.amounts.length)
    problems.push(`${milestones.length} milestones, expected ${test.expect.amounts.length}`);
  (test.expect.amounts ?? []).forEach((expected, i) => {
    const wei = milestones[i]?.amountWei;
    if (!wei) problems.push(`milestone ${i + 1} has no amount`);
    else if (!close(original(wei, rate), expected)) problems.push(`milestone ${i + 1} is ${original(wei, rate).toFixed(2)}, expected ${expected}`);
  });
  if (test.expect.total && result?.draftSpec.totalAmountWei && !close(original(result.draftSpec.totalAmountWei, rate), test.expect.total))
    problems.push(`total ${original(result.draftSpec.totalAmountWei, rate).toFixed(2)}, expected ${test.expect.total}`);
  for (const word of test.expect.notEnforced ?? [])
    if (!(draft.settledTerms ?? []).some(term => term.toLowerCase().includes(word.toLowerCase())))
      problems.push(`"${word}" not listed as not enforced`);
  if (test.expect.maxTurns && turns > test.expect.maxTurns) problems.push(`${turns} turns, expected at most ${test.expect.maxTurns}`);
  return problems;
}

async function run(test) {
  let draft = await call('/drafts', {});
  let turns = 0;
  for (const [index, message] of test.messages.entries()) {
    draft = await call(`/drafts/${draft.id}/messages`, {
      message, expectedRevision: draft.revision, requestKey: `eval-${test.id}-${index}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '') });
    turns++;
    if (draft.result?.status === 'readyForConfirmation') break;
  }
  const problems = score(test, draft, turns);
  // Leave nothing behind in the user's project list.
  await call(`/drafts/${draft.id}/discard`, {}).catch(() => {});
  return { id: test.id, turns, passed: problems.length === 0, problems,
    question: draft.turns?.at(-1)?.question?.question ?? null };
}

(async () => {
  const context = await call('/drafts/context');
  if (!context.clarificationEnabled) throw new Error('Start the backend with npm run demo:live (Agent 1 is off).');
  const selected = cases.filter(test => !only.length || only.includes(test.id));
  const results = [];
  for (const test of selected) {
    try { results.push(await run(test)); }
    catch (error) { results.push({ id: test.id, turns: 0, passed: false, problems: [error.message] }); }
    const last = results.at(-1);
    console.log(`${last.passed ? 'PASS' : 'FAIL'}  ${last.id.padEnd(22)} ${last.turns} turn(s)  ${last.problems.join('; ')}`);
  }
  const passed = results.filter(r => r.passed);
  const firstTurn = passed.filter(r => r.turns === 1).length;
  console.log(`\n${passed.length}/${results.length} reached a correct agreement; ${firstTurn} in the first message.`);
  mkdirSync(join(root, 'data/private'), { recursive: true });
  const file = join(root, 'data/private', `agent1-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ api, results }, null, 2));
  console.log(`Details: ${file}`);
  process.exitCode = passed.length === results.length ? 0 : 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
