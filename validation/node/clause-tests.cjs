// Independent clause tests for IMilestoneEscrow v1 (suite clause-v1).
// Input (stdin): {abi, bytecode, specAmounts, buildSettings}, where abi/bytecode come from the
// validator's own recompilation. Output (stdout): one JSON object {suite, results, warnings}.
// Assertions use mined receipts, balances and state only; never implementation error names.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '../..'));   // reuse the repository's Hardhat config
const hre = require('hardhat');
const solc = require('solc');
const { BrowserProvider, ContractFactory, Interface, ZeroAddress, parseEther } = require('ethers');

const SUITE = 'clause-v1';
const GAS = { gasLimit: 3000000 };
const EVENTS = new Interface([
  'event Deposited(address indexed client, uint256 amount)',
  'event MilestonePaid(uint256 indexed id, address indexed provider, uint256 amount)']);
const GENERIC = ['0.003', '0.007', '0.002', '0.004', '0.001'].map(parseEther);
const HELPERS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract ForceSend { constructor(address payable to) payable { selfdestruct(to); } }
contract Rejector { }
contract Reentrant {
  address public target; bool public entered;
  function setTarget(address t) external { target = t; }
  receive() external payable {
    if (target != address(0) && !entered) {
      entered = true;
      target.call(abi.encodeWithSignature("acceptMilestone(uint256)", 2));
      target.call(abi.encodeWithSignature("acceptMilestone(uint256)", 1));
      target.call(abi.encodeWithSignature("deposit()"));
    }
  }
}`;

const sum = a => a.reduce((x, y) => x + y, 0n);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function check(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, what) { check(same(actual, expected), `${what}: got ${actual}, expected ${expected}`); }

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (hre.config.networks.hardhat.throwOnTransactionFailures !== false) {
    return { toolError: 'hardhat.config.cjs must keep throwOnTransactionFailures:false so reverted receipts can be inspected' };
  }
  const helperOut = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Helpers.sol': { content: HELPERS } },
    settings: { ...input.buildSettings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  if ((helperOut.errors || []).some(e => e.severity === 'error')) return { toolError: 'Test helper contracts failed to compile' };
  const helper = name => helperOut.contracts['Helpers.sol'][name];

  const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const [client, payee, outsider] = await Promise.all([0, 1, 2].map(i => provider.getSigner(i)));
  const clientAddr = await client.getAddress(), payeeAddr = await payee.getAddress();
  const factory = new ContractFactory(input.abi, input.bytecode, client);
  const helperFactory = name => new ContractFactory(helper(name).abi, '0x' + helper(name).evm.bytecode.object, client);
  const balance = async a => BigInt(await provider.send('eth_getBalance', [typeof a === 'string' ? a : await a.getAddress(), 'latest']));
  const specAmounts = input.specAmounts.map(BigInt);

  async function deploy(amounts, recipient = payeeAddr) {
    const c = await factory.deploy(clientAddr, recipient, amounts, GAS);
    const receipt = await c.deploymentTransaction().wait().catch(e => { throw new Error('valid constructor arguments reverted: ' + (e.shortMessage || e.message)); });
    check(receipt.status === 1, 'valid constructor arguments reverted');
    return c;
  }
  async function snapshot(c, n, recipient) {
    const s = { funded: await c.funded(), total: await c.totalAmount(), count: await c.milestoneCount(),
      escrow: await balance(c), recipient: await balance(recipient), paid: [], amounts: [] };
    for (let i = 1; i <= n; i++) { s.paid.push(await c.isPaid(i)); s.amounts.push(await c.milestoneAmount(i)); }
    return s;
  }
  // A rejected call must be mined with status 0, leave no logs, and change no escrow state or funds.
  async function rejected(label, send, c, n, { recipient = payeeAddr, recipientSends = false } = {}) {
    const before = await snapshot(c, n, recipient);
    let receipt;
    try { receipt = await (await send()).wait(); }
    catch (e) { if (e.receipt) receipt = e.receipt; else throw new Error(`${label}: not mined as a transaction (${e.shortMessage || e.message})`); }
    check(receipt.status === 0, `${label}: expected a revert, but the transaction succeeded`);
    check(receipt.logs.length === 0, `${label}: reverted transaction left ${receipt.logs.length} log(s)`);
    const after = await snapshot(c, n, recipient);
    if (recipientSends) { delete before.recipient; delete after.recipient; }
    const diff = Object.keys(before).filter(k => JSON.stringify(before[k], (_, v) => typeof v === 'bigint' ? String(v) : v) !==
      JSON.stringify(after[k], (_, v) => typeof v === 'bigint' ? String(v) : v));
    check(diff.length === 0, `${label}: state changed after a rejected transaction (${diff.join(', ')})`);
  }
  async function ok(label, send) {
    let receipt;
    try { receipt = await (await send()).wait(); } catch (e) { throw new Error(`${label}: unexpectedly reverted`); }
    check(receipt.status === 1, `${label}: unexpectedly reverted`);
    return receipt;
  }
  function hasEvent(receipt, c, name, expected) {
    const target = c.target.toLowerCase();
    const found = receipt.logs.filter(l => l.address.toLowerCase() === target).map(l => { try { return EVENTS.parseLog(l); } catch { return null; } })
      .filter(e => e && e.name === name);
    check(found.some(e => Object.entries(expected).every(([k, v]) => same(e.args[k], v))),
      `${name} event with ${JSON.stringify(expected, (_, v) => typeof v === 'bigint' ? String(v) : v)} not emitted`);
  }

  async function flow(amounts) {
    const n = amounts.length, total = sum(amounts);
    if (total + parseEther('1') > await balance(clientAddr)) {
      await provider.send('hardhat_setBalance', [clientAddr, '0x' + (total + parseEther('10')).toString(16)]);
    }
    const c = await deploy(amounts);
    eq(await c.client(), clientAddr, 'client()'); eq(await c.provider(), payeeAddr, 'provider()');
    eq(await c.totalAmount(), total, 'totalAmount()'); eq(await c.milestoneCount(), n, 'milestoneCount()');
    eq(await c.funded(), false, 'funded() before deposit');
    for (let i = 1; i <= n; i++) { eq(await c.milestoneAmount(i), amounts[i - 1], `milestoneAmount(${i})`); eq(await c.isPaid(i), false, `isPaid(${i}) before payment`); }
    const start = await balance(payeeAddr);
    const dep = await ok('deposit(total)', () => c.deposit({ ...GAS, value: total }));
    hasEvent(dep, c, 'Deposited', { client: clientAddr, amount: total });
    eq(await c.funded(), true, 'funded() after deposit'); eq(await balance(c), total, 'escrow balance after deposit');
    let released = 0n;
    for (let id = 1; id <= n; id++) {
      const r = await ok(`acceptMilestone(${id})`, () => c.acceptMilestone(id, GAS));
      hasEvent(r, c, 'MilestonePaid', { id: BigInt(id), provider: payeeAddr, amount: amounts[id - 1] });
      released += amounts[id - 1];
      for (let j = 1; j <= n; j++) eq(await c.isPaid(j), j <= id, `isPaid(${j}) after accepting ${id}`);
      eq(await balance(c), total - released, `escrow balance after accepting ${id}`);
      eq(await balance(payeeAddr) - start, released, `developer received after accepting ${id}`);
    }
  }

  const tests = [];
  const add = (id, clause, fn) => tests.push({ id, clause, fn });
  for (const n of [1, 2, 3, 5]) add(`flow-${n}`, `${n}-milestone payment flow: getters, deposit, in-order payments, exact developer amounts, events`, () => flow(GENERIC.slice(0, n)));
  add('flow-spec', 'Payment flow with the confirmed spec amounts', () => flow(specAmounts));

  add('access-deposit', 'Only the client can deposit', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a);
    await rejected('deposit by outsider', () => c.connect(outsider).deposit({ ...GAS, value: sum(a) }), c, 3);
    await rejected('deposit by developer', () => c.connect(payee).deposit({ ...GAS, value: sum(a) }), c, 3, { recipientSends: true });
  });
  add('access-accept', 'Only the client can accept each milestone', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a);
    await ok('deposit', () => c.deposit({ ...GAS, value: sum(a) }));
    for (let id = 1; id <= 3; id++) {
      await rejected(`acceptMilestone(${id}) by outsider`, () => c.connect(outsider).acceptMilestone(id, GAS), c, 3);
      await rejected(`acceptMilestone(${id}) by developer`, () => c.connect(payee).acceptMilestone(id, GAS), c, 3, { recipientSends: true });
      await ok(`acceptMilestone(${id}) by client`, () => c.acceptMilestone(id, GAS));
    }
  });
  add('deposit-exact', 'Deposit must equal the total amount', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a), t = sum(a);
    for (const v of [0n, t - 1n, t + 1n]) await rejected(`deposit(${v} wei)`, () => c.deposit({ ...GAS, value: v }), c, 3);
    await ok('deposit(total) after rejected attempts', () => c.deposit({ ...GAS, value: t }));
  });
  add('deposit-once', 'Deposit can happen only once, including mid-way and after completion', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a), t = sum(a);
    await ok('first deposit', () => c.deposit({ ...GAS, value: t }));
    await rejected('second deposit while funded', () => c.deposit({ ...GAS, value: t }), c, 3);
    await ok('acceptMilestone(1)', () => c.acceptMilestone(1, GAS));
    await rejected('deposit after first payment', () => c.deposit({ ...GAS, value: t }), c, 3);
    await ok('acceptMilestone(2)', () => c.acceptMilestone(2, GAS)); await ok('acceptMilestone(3)', () => c.acceptMilestone(3, GAS));
    await rejected('deposit after completion', () => c.deposit({ ...GAS, value: t }), c, 3);
  });
  add('unfunded-accept', 'No payment before deposit', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a);
    for (let id = 1; id <= 3; id++) await rejected(`acceptMilestone(${id}) before deposit`, () => c.acceptMilestone(id, GAS), c, 3);
  });
  add('unfunded-forced-eth', 'No payment before deposit even after ETH is force-sent to the contract', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a);
    const f = await helperFactory('ForceSend').deploy(c.target, { ...GAS, value: sum(a) });
    await f.waitForDeployment();
    eq(await balance(c), sum(a), 'escrow balance after forced send');
    for (let id = 1; id <= 3; id++) await rejected(`acceptMilestone(${id}) with forced ETH but no deposit`, () => c.acceptMilestone(id, GAS), c, 3);
  });
  add('order-skip', 'Milestones must be paid in order', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a);
    await ok('deposit', () => c.deposit({ ...GAS, value: sum(a) }));
    await rejected('acceptMilestone(2) before 1', () => c.acceptMilestone(2, GAS), c, 3);
    await rejected('acceptMilestone(3) before 1', () => c.acceptMilestone(3, GAS), c, 3);
    await ok('acceptMilestone(1)', () => c.acceptMilestone(1, GAS));
    await rejected('acceptMilestone(3) before 2', () => c.acceptMilestone(3, GAS), c, 3);
    await ok('acceptMilestone(2)', () => c.acceptMilestone(2, GAS)); await ok('acceptMilestone(3)', () => c.acceptMilestone(3, GAS));
  });
  add('order-repeat', 'Each milestone is paid only once, including after completion', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a);
    await ok('deposit', () => c.deposit({ ...GAS, value: sum(a) }));
    for (let id = 1; id <= 3; id++) {
      await ok(`acceptMilestone(${id})`, () => c.acceptMilestone(id, GAS));
      await rejected(`repeat acceptMilestone(${id})`, () => c.acceptMilestone(id, GAS), c, 3);
    }
    for (let id = 1; id <= 3; id++) await rejected(`acceptMilestone(${id}) after completion`, () => c.acceptMilestone(id, GAS), c, 3);
  });
  add('recipient-reject-rollback', 'If the developer rejects the payment, balance, state and events roll back', async () => {
    const a = GENERIC.slice(0, 3), r = await helperFactory('Rejector').deploy(GAS); await r.waitForDeployment();
    const c = await deploy(a, r.target);
    await ok('deposit', () => c.deposit({ ...GAS, value: sum(a) }));
    await rejected('acceptMilestone(1) to a rejecting recipient', () => c.acceptMilestone(1, GAS), c, 3, { recipient: r.target });
  });
  add('recipient-reentry', 'A re-entering recipient cannot obtain extra payments or break accounting', async () => {
    const a = GENERIC.slice(0, 3), r = await helperFactory('Reentrant').deploy(GAS); await r.waitForDeployment();
    const c = await deploy(a, r.target);
    await ok('setTarget', () => r.setTarget(c.target, GAS));
    await ok('deposit', () => c.deposit({ ...GAS, value: sum(a) }));
    let status;
    try { status = (await (await c.acceptMilestone(1, GAS)).wait()).status; } catch (e) { status = e.receipt ? e.receipt.status : null; }
    check(status === 0 || status === 1, 'acceptMilestone(1) was not mined');
    const paid = []; for (let i = 1; i <= 3; i++) paid.push(await c.isPaid(i));
    const paidSum = a.filter((_, i) => paid[i]).reduce((x, y) => x + y, 0n);
    check(!paid[1] && !paid[2], 'a re-entering recipient caused a later milestone to be marked paid');
    eq(await balance(r.target), paidSum, 'recipient balance equals the sum of milestones marked paid');
    eq(await balance(c), sum(a) - paidSum, 'escrow balance equals total minus paid milestones');
    if (status === 1) eq(paid[0], true, 'isPaid(1) after successful payment');
  });
  const ctor = (id, clause, amounts, who) => add(id, clause, async () => {
    const c1 = who === 'zero-client' ? ZeroAddress : clientAddr;
    const c2 = who === 'zero-provider' ? ZeroAddress : who === 'same' ? clientAddr : payeeAddr;
    let receipt;
    try { const d = await factory.deploy(c1, c2, amounts, GAS); receipt = await d.deploymentTransaction().wait(); }
    catch (e) { if (e.receipt) receipt = e.receipt; else throw new Error(`deployment not mined (${e.shortMessage || e.message})`); }
    check(receipt.status === 0, 'deployment succeeded; expected the constructor to revert');
  });
  ctor('constructor-0', 'Constructor rejects 0 milestones', [], 'ok');
  ctor('constructor-6', 'Constructor rejects 6 milestones', Array(6).fill(1n), 'ok');
  ctor('constructor-zero-first', 'Constructor rejects a zero first amount', [0n, 1n], 'ok');
  ctor('constructor-zero-later', 'Constructor rejects a zero later amount', [1n, 0n], 'ok');
  ctor('constructor-zero-client', 'Constructor rejects a zero client address', [1n], 'zero-client');
  ctor('constructor-zero-provider', 'Constructor rejects a zero developer address', [1n], 'zero-provider');
  ctor('constructor-same-parties', 'Constructor rejects identical client and developer', [1n], 'same');
  const warnings = [];
  add('id-out-of-range', 'Milestone IDs 0 and count+1 cannot be accepted', async () => {
    const a = GENERIC.slice(0, 3), c = await deploy(a);
    await ok('deposit', () => c.deposit({ ...GAS, value: sum(a) }));
    for (const id of [0, 4]) await rejected(`acceptMilestone(${id})`, () => c.acceptMilestone(id, GAS), c, 3);
    for (const [fn, id] of [['milestoneAmount', 0], ['milestoneAmount', 4], ['isPaid', 0], ['isPaid', 4]]) {
      try { const v = await c[fn](id); warnings.push({ code: 'VIEW_OUT_OF_RANGE', message: `${fn}(${id}) returned ${v} instead of reverting (non-blocking)` }); } catch { /* reverting is the reference behaviour */ }
    }
  });

  const results = [];
  for (const t of tests) {
    try { await t.fn(); results.push({ id: t.id, clause: t.clause, status: 'passed', message: null }); }
    catch (e) { results.push({ id: t.id, clause: t.clause, status: 'failed', message: String(e && e.message || e).slice(0, 500) }); }
  }
  return { suite: SUITE, results, warnings };
}

main().then(out => console.log(JSON.stringify(out)))
  .catch(e => console.log(JSON.stringify({ toolError: 'Clause test harness failed: ' + (e && e.message || String(e)) })));
