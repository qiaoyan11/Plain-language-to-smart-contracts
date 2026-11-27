// The v2 review-period clause suite passes the reference contract and catches deliberate bugs.
// Runs the same harness the v2 validator uses (tests/v2/node/review-clause-tests.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const solc = require('solc');

const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, 'contracts', name), 'utf8');
const SETTINGS = { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } };
const REFERENCE = read('MilestoneReviewEscrow.sol');

function build(source) {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
    'IMilestoneEscrow.sol': { content: read('IMilestoneEscrow.sol') },
    'IMilestoneReviewEscrow.sol': { content: read('IMilestoneReviewEscrow.sol') },
    'MilestoneReviewEscrow.sol': { content: source } },
  settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errors = (out.errors || []).filter(e => e.severity === 'error');
  assert.equal(errors.length, 0, errors.map(e => e.formattedMessage).join('\n'));
  const c = out.contracts['MilestoneReviewEscrow.sol'].MilestoneReviewEscrow;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}
function run(source, { period = 864000, limit = 0 } = {}) {
  const input = { ...build(source), specAmounts: ['1000', '2000'], reviewPeriodSeconds: period, changeRequestLimit: limit, buildSettings: SETTINGS };
  const lines = execFileSync(process.execPath, [path.join(__dirname, 'node/review-clause-tests.cjs')],
    { input: JSON.stringify(input), cwd: root, maxBuffer: 1 << 24 }).toString().trim().split('\n');
  const out = JSON.parse(lines.at(-1));
  assert.equal(out.toolError, undefined, out.toolError);
  return Object.fromEntries(out.results.map(r => [r.id, r]));
}
function mutate(from, to, extra = s => s) {
  assert.ok(REFERENCE.includes(from), `mutation anchor missing: ${from}`);
  return extra(REFERENCE.replace(from, to));
}
const failed = results => Object.values(results).filter(r => r.status !== 'passed').map(r => r.id);

test('the reference contract passes every review clause', { timeout: 120000 }, () => {
  assert.deepEqual(failed(run(REFERENCE)), []);
});

test('a two-request limit is enforced and confirmed', { timeout: 120000 }, () => {
  const limited = mutate('changeRequestLimit = 0;', 'changeRequestLimit = 2;');
  assert.deepEqual(failed(run(limited, { limit: 2 })), []);
  // The same contract does not match a confirmed rule of "no limit".
  assert.ok(failed(run(limited, { limit: 0 })).includes('review-constants'));
});

const MUTANTS = [
  ['claim one second early', 'if (at == 0 || block.timestamp < at + reviewPeriod) revert InvalidState();\n        pay(id);',
    'if (at == 0 || block.timestamp + 1 < at + reviewPeriod) revert InvalidState();\n        pay(id);', 'review-claim-after-period'],
  ['anyone can claim', 'function claimMilestone(uint256 id) external override onlyProvider {',
    'function claimMilestone(uint256 id) external override {', 'review-access'],
  ['claim without a delivery', 'if (at == 0 || block.timestamp < at + reviewPeriod) revert InvalidState();\n        pay(id);',
    'if (block.timestamp < at + reviewPeriod) revert InvalidState();\n        pay(id);', 'review-claim-needs-delivery'],
  ['late change request accepted', 'if (at == 0 || block.timestamp >= at + reviewPeriod) revert InvalidState();',
    'if (at == 0 || block.timestamp > at + reviewPeriod) revert InvalidState();', 'review-changes-too-late'],
  ['change request keeps the delivery', '        delivered[id] = 0;\n        uint256 count',
    '        uint256 count', 'review-changes-restart'],
  ['delivery submitted twice', '        if (delivered[id] != 0) revert InvalidState();\n', '', 'review-order'],
  ['wrong review period', 'reviewPeriod = 10 days;', 'reviewPeriod = 9 days;', 'review-constants'],
];
for (const [name, from, to, clause] of MUTANTS) {
  test(`catches: ${name}`, { timeout: 120000 }, () => {
    assert.ok(failed(run(mutate(from, to))).includes(clause), `${clause} did not fail`);
  });
}

test('catches: the limit is declared but not enforced', { timeout: 120000 }, () => {
  const ignored = mutate('changeRequestLimit = 0;', 'changeRequestLimit = 2;',
    s => s.replace('if (changeRequestLimit != 0 && requests[id] >= changeRequestLimit) revert InvalidState();', ''));
  assert.ok(failed(run(ignored, { limit: 2 })).includes('review-change-limit'));
});
