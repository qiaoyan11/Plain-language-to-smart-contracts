// Independent clause tests for the v2 review period (IMilestoneReviewEscrow, suite review-v1).
// Input (stdin): {abi, bytecode, specAmounts, reviewPeriodSeconds, changeRequestLimit, buildSettings},
// where abi/bytecode come from the validator's own recompilation. Output (stdout): one JSON object
// {suite, results, warnings}. Assertions use mined receipts, balances, chain time and state only.
// The v1 clause suite (validation/node/clause-tests.cjs) runs separately on the same contract.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '../../..'));   // reuse the repository's Hardhat config
const hre = require('hardhat');
const solc = require('solc');
const { BrowserProvider, ContractFactory, Interface, parseEther } = require('ethers');

const SUITE = 'review-v1';
const GAS = { gasLimit: 3000000 };
const EVENTS = new Interface([
  'event MilestonePaid(uint256 indexed id, address indexed provider, uint256 amount)',
  'event DeliverySubmitted(uint256 indexed id, uint256 reviewEndsAt)',
  'event ChangesRequested(uint256 indexed id, uint256 requestCount)']);
const AMOUNTS = ['0.003', '0.007', '0.002'].map(parseEther);
// A provider that is a contract: it submits and claims, can refuse payment, or re-enter on payment.
const HELPERS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract ForceSend { constructor(address payable to) payable { selfdestruct(to); } }
contract ProviderAgent {
  address public target; bool public refuse; bool public reenter; bool public entered;
  function setTarget(address t) external { target = t; }
  function setRefuse(bool v) external { refuse = v; }
  function setReenter(bool v) external { reenter = v; }
  function submit(uint256 id) external { (bool ok, ) = target.call(abi.encodeWithSignature("submitDelivery(uint256)", id)); require(ok, "submit"); }
  function claim(uint256 id) external { (bool ok, ) = target.call(abi.encodeWithSignature("claimMilestone(uint256)", id)); require(ok, "claim"); }
  receive() external payable {
    require(!refuse, "refused");
    if (reenter && !entered) {
      entered = true;
      target.call(abi.encodeWithSignature("claimMilestone(uint256)", 1));
      target.call(abi.encodeWithSignature("submitDelivery(uint256)", 2));
      target.call(abi.encodeWithSignature("claimMilestone(uint256)", 2));
    }
  }
}`;

const sum = a => a.reduce((x, y) => x + y, 0n);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const show = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x);
function check(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, what) { check(same(actual, expected), `${what}: got ${actual}, expected ${expected}`); }

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (hre.config.networks.hardhat.throwOnTransactionFailures !== false)
    return { toolError: 'hardhat.config.cjs must keep throwOnTransactionFailures:false so reverted receipts can be inspected' };
  const period = BigInt(input.reviewPeriodSeconds), limit = BigInt(input.changeRequestLimit ?? 0);
  if (period < 1n) return { toolError: 'reviewPeriodSeconds must be positive' };
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
  const now = async () => BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp);
  const at = async ts => provider.send('evm_setNextBlockTimestamp', ['0x' + ts.toString(16)]);

  async function deploy(amounts, recipient = payeeAddr) {
    const c = await factory.deploy(clientAddr, recipient, amounts, GAS);
    const receipt = await c.deploymentTransaction().wait().catch(e => { throw new Error('valid constructor arguments reverted: ' + (e.shortMessage || e.message)); });
    check(receipt.status === 1, 'valid constructor arguments reverted');
    return c;
  }
  async function funded(amounts = AMOUNTS, recipient = payeeAddr) {
    const c = await deploy(amounts, recipient);
    await ok('deposit', () => c.deposit({ ...GAS, value: sum(amounts) }));
    return c;
  }
  async function snapshot(c, n, recipient) {
    const s = { funded: await c.funded(), escrow: await balance(c), recipient: await balance(recipient),
      paid: [], delivered: [], requests: [] };
    for (let i = 1; i <= n; i++) {
      s.paid.push(await c.isPaid(i)); s.delivered.push(await c.deliveredAt(i)); s.requests.push(await c.changeRequests(i));
    }
    return s;
  }
  // A rejected call must be mined with status 0, leave no logs, and change no escrow state or funds.
  async function rejected(label, send, c, { n = AMOUNTS.length, recipient = payeeAddr, recipientSends = false } = {}) {
    const before = await snapshot(c, n, recipient);
    let receipt;
    try { receipt = await (await send()).wait(); }
    catch (e) { if (e.receipt) receipt = e.receipt; else throw new Error(`${label}: not mined as a transaction (${e.shortMessage || e.message})`); }
    check(receipt.status === 0, `${label}: expected a revert, but the transaction succeeded`);
    check(receipt.logs.length === 0, `${label}: reverted transaction left ${receipt.logs.length} log(s)`);
    const after = await snapshot(c, n, recipient);
    if (recipientSends) { delete before.recipient; delete after.recipient; }
    const diff = Object.keys(before).filter(k => show(before[k]) !== show(after[k]));
    check(diff.length === 0, `${label}: state changed after a rejected transaction (${diff.join(', ')})`);
  }
  async function ok(label, send) {
    let receipt;
    try { receipt = await (await send()).wait(); } catch (e) { throw new Error(`${label}: unexpectedly reverted`); }
    check(receipt.status === 1, `${label}: unexpectedly reverted`);
    return receipt;
  }
  function hasEvent(receipt, c, name, expected) {
    const found = receipt.logs.filter(l => same(l.address, c.target)).map(l => { try { return EVENTS.parseLog(l); } catch { return null; } })
      .filter(e => e && e.name === name);
    check(found.some(e => Object.entries(expected).every(([k, v]) => same(e.args[k], v))), `${name} event with ${show(expected)} not emitted`);
  }
  // Submits milestone `id` and returns the block time the review started.
  async function submit(c, id, signer = payee) {
    const r = await ok(`submitDelivery(${id})`, () => c.connect(signer).submitDelivery(id, GAS));
    const started = BigInt((await provider.getBlock(r.blockNumber)).timestamp);
    hasEvent(r, c, 'DeliverySubmitted', { id: BigInt(id), reviewEndsAt: started + period });
    eq(await c.deliveredAt(id), started, `deliveredAt(${id}) after submission`);
    return started;
  }

  const tests = [];
  const add = (id, clause, fn) => tests.push({ id, clause, fn });

  add('review-constants', 'The review period and change-request limit are the confirmed ones', async () => {
    const c = await deploy(AMOUNTS);
    eq(await c.reviewPeriod(), period, 'reviewPeriod()');
    eq(await c.changeRequestLimit(), limit, 'changeRequestLimit()');
    for (let i = 1; i <= AMOUNTS.length; i++) {
      eq(await c.deliveredAt(i), 0n, `deliveredAt(${i}) before any delivery`);
      eq(await c.changeRequests(i), 0n, `changeRequests(${i}) before any request`);
    }
  });
  add('review-claim-after-period', 'Silence for the whole review period lets the provider claim the exact payment, once', async () => {
    const c = await funded(), start = await balance(payeeAddr);
    const started = await submit(c, 1);
    await at(started + period - 1n);
    await rejected('claimMilestone(1) one second before the review ends', () => c.connect(payee).claimMilestone(1, GAS), c, { recipientSends: true });
    const end = await now() > started + period ? await now() + 1n : started + period;
    await at(end);
    const r = await ok('claimMilestone(1) when the review ends', () => c.connect(payee).claimMilestone(1, GAS));
    hasEvent(r, c, 'MilestonePaid', { id: 1n, provider: payeeAddr, amount: AMOUNTS[0] });
    eq(await c.isPaid(1), true, 'isPaid(1) after the claim'); eq(await c.isPaid(2), false, 'isPaid(2) after claiming 1');
    eq(await c.deliveredAt(1), 0n, 'deliveredAt(1) after payment');
    eq(await balance(c), sum(AMOUNTS) - AMOUNTS[0], 'escrow balance after the claim');
    check(await balance(payeeAddr) > start, 'provider balance did not increase');
    await rejected('second claimMilestone(1)', () => c.connect(payee).claimMilestone(1, GAS), c, { recipientSends: true });
    // The next milestone still follows v1: the client may approve it without any delivery.
    await ok('acceptMilestone(2) by the client', () => c.acceptMilestone(2, GAS));
  });
  add('review-claim-needs-delivery', 'No claim without a delivery awaiting review, however much time passes', async () => {
    const c = await funded();
    await at(await now() + period * 3n);
    await rejected('claimMilestone(1) without a delivery', () => c.connect(payee).claimMilestone(1, GAS), c, { recipientSends: true });
  });
  add('review-access', 'Only the provider submits and claims; only the client requests changes', async () => {
    const c = await funded();
    await rejected('submitDelivery(1) by the client', () => c.submitDelivery(1, GAS), c);
    await rejected('submitDelivery(1) by an outsider', () => c.connect(outsider).submitDelivery(1, GAS), c);
    const started = await submit(c, 1);
    await rejected('requestChanges(1) by the provider', () => c.connect(payee).requestChanges(1, GAS), c, { recipientSends: true });
    await rejected('requestChanges(1) by an outsider', () => c.connect(outsider).requestChanges(1, GAS), c);
    await at(started + period);
    await rejected('claimMilestone(1) by the client', () => c.claimMilestone(1, GAS), c);
    await rejected('claimMilestone(1) by an outsider', () => c.connect(outsider).claimMilestone(1, GAS), c);
    await ok('claimMilestone(1) by the provider', () => c.connect(payee).claimMilestone(1, GAS));
  });
  add('review-unfunded', 'Before the deposit nothing can be submitted or claimed, even with force-sent ETH', async () => {
    const c = await deploy(AMOUNTS);
    await rejected('submitDelivery(1) before the deposit', () => c.connect(payee).submitDelivery(1, GAS), c, { recipientSends: true });
    const f = await helperFactory('ForceSend').deploy(c.target, { ...GAS, value: sum(AMOUNTS) }); await f.waitForDeployment();
    await rejected('submitDelivery(1) with forced ETH but no deposit', () => c.connect(payee).submitDelivery(1, GAS), c, { recipientSends: true });
    await at(await now() + period * 2n);
    await rejected('claimMilestone(1) with forced ETH but no deposit', () => c.connect(payee).claimMilestone(1, GAS), c, { recipientSends: true });
  });
  add('review-order', 'Only the next unpaid milestone can be submitted, reviewed or claimed', async () => {
    const c = await funded();
    await rejected('submitDelivery(2) before 1 is paid', () => c.connect(payee).submitDelivery(2, GAS), c, { recipientSends: true });
    for (const id of [0, 4]) await rejected(`submitDelivery(${id})`, () => c.connect(payee).submitDelivery(id, GAS), c, { recipientSends: true });
    const started = await submit(c, 1);
    await rejected('submitDelivery(1) while it awaits review', () => c.connect(payee).submitDelivery(1, GAS), c, { recipientSends: true });
    await at(started + period);
    await rejected('claimMilestone(2) before 1 is paid', () => c.connect(payee).claimMilestone(2, GAS), c, { recipientSends: true });
    await ok('claimMilestone(1)', () => c.connect(payee).claimMilestone(1, GAS));
    await rejected('submitDelivery(1) after it is paid', () => c.connect(payee).submitDelivery(1, GAS), c, { recipientSends: true });
  });
  add('review-changes-restart', 'A change request inside the period withdraws the delivery; a new submission restarts the clock', async () => {
    const c = await funded();
    const first = await submit(c, 1);
    await at(first + period - 1n);
    const r = await ok('requestChanges(1) one second before the review ends', () => c.requestChanges(1, GAS));
    hasEvent(r, c, 'ChangesRequested', { id: 1n, requestCount: 1n });
    eq(await c.deliveredAt(1), 0n, 'deliveredAt(1) after the change request');
    eq(await c.changeRequests(1), 1n, 'changeRequests(1) after the change request');
    await at(first + period + 1n);
    await rejected('claimMilestone(1) after the original period, with the delivery withdrawn', () => c.connect(payee).claimMilestone(1, GAS), c, { recipientSends: true });
    await rejected('requestChanges(1) with no delivery awaiting review', () => c.requestChanges(1, GAS), c);
    const second = await submit(c, 1);
    await at(second + period - 1n);
    await rejected('claimMilestone(1) before the new period ends', () => c.connect(payee).claimMilestone(1, GAS), c, { recipientSends: true });
    await at(second + period);
    await ok('claimMilestone(1) after the new period', () => c.connect(payee).claimMilestone(1, GAS));
    eq(await c.isPaid(1), true, 'isPaid(1)');
  });
  add('review-changes-too-late', 'Changes can no longer be requested once the review period has ended', async () => {
    const c = await funded();
    const started = await submit(c, 1);
    await at(started + period);
    await rejected('requestChanges(1) when the review ends', () => c.requestChanges(1, GAS), c);
    await ok('claimMilestone(1)', () => c.connect(payee).claimMilestone(1, GAS));
  });
  add('review-client-approves', 'The client can approve during the review; the delivery cannot then be claimed again', async () => {
    const c = await funded();
    const started = await submit(c, 1);
    const r = await ok('acceptMilestone(1) during the review', () => c.acceptMilestone(1, GAS));
    hasEvent(r, c, 'MilestonePaid', { id: 1n, provider: payeeAddr, amount: AMOUNTS[0] });
    eq(await c.deliveredAt(1), 0n, 'deliveredAt(1) after approval');
    await at(started + period);
    await rejected('claimMilestone(1) after the client approved it', () => c.connect(payee).claimMilestone(1, GAS), c, { recipientSends: true });
    eq(await balance(c), sum(AMOUNTS) - AMOUNTS[0], 'escrow balance: milestone 1 paid exactly once');
  });
  add('review-change-limit', limit > 0n
    ? `At most ${limit} change request(s) per milestone; after that silence still releases payment`
    : 'With no limit, the client may request changes repeatedly', async () => {
    const c = await funded();
    const rounds = limit > 0n ? Number(limit) : 3;
    for (let i = 1; i <= rounds; i++) {
      await submit(c, 1);
      await ok(`change request ${i}`, () => c.requestChanges(1, GAS));
      eq(await c.changeRequests(1), BigInt(i), `changeRequests(1) after request ${i}`);
    }
    const started = await submit(c, 1);
    if (limit > 0n) await rejected(`change request ${rounds + 1} beyond the limit`, () => c.requestChanges(1, GAS), c);
    await at(started + period);
    await ok('claimMilestone(1) after the last review', () => c.connect(payee).claimMilestone(1, GAS));
  });
  add('review-recipient-rejects', 'If the provider cannot receive the claim, nothing changes and the delivery still awaits payment', async () => {
    const agent = await helperFactory('ProviderAgent').deploy(GAS); await agent.waitForDeployment();
    const c = await funded(AMOUNTS, agent.target);
    await ok('setTarget', () => agent.setTarget(c.target, GAS));
    const r = await ok('submitDelivery(1) through the provider contract', () => agent.submit(1, GAS));
    const started = BigInt((await provider.getBlock(r.blockNumber)).timestamp);
    await ok('setRefuse', () => agent.setRefuse(true, GAS));
    await at(started + period);
    const before = await snapshot(c, AMOUNTS.length, agent.target);
    let status;
    try { status = (await (await agent.claim(1, GAS)).wait()).status; } catch (e) { status = e.receipt ? e.receipt.status : null; }
    check(status === 0, 'a claim the provider cannot receive was not reverted');
    check(show(await snapshot(c, AMOUNTS.length, agent.target)) === show(before), 'state changed after a refused claim');
  });
  add('review-reentry', 'A re-entering provider cannot obtain extra payments or break accounting', async () => {
    const agent = await helperFactory('ProviderAgent').deploy(GAS); await agent.waitForDeployment();
    const c = await funded(AMOUNTS, agent.target);
    await ok('setTarget', () => agent.setTarget(c.target, GAS));
    const r = await ok('submitDelivery(1)', () => agent.submit(1, GAS));
    const started = BigInt((await provider.getBlock(r.blockNumber)).timestamp);
    await ok('setReenter', () => agent.setReenter(true, GAS));
    await at(started + period);
    let status;
    try { status = (await (await agent.claim(1, GAS)).wait()).status; } catch (e) { status = e.receipt ? e.receipt.status : null; }
    check(status === 0 || status === 1, 'claimMilestone(1) was not mined');
    const paid = []; for (let i = 1; i <= AMOUNTS.length; i++) paid.push(await c.isPaid(i));
    check(!paid[1] && !paid[2], 'a re-entering provider caused a later milestone to be marked paid');
    const paidSum = AMOUNTS.filter((_, i) => paid[i]).reduce((x, y) => x + y, 0n);
    eq(await balance(agent.target), paidSum, 'provider balance equals the sum of milestones marked paid');
    eq(await balance(c), sum(AMOUNTS) - paidSum, 'escrow balance equals total minus paid milestones');
  });

  const results = [];
  for (const t of tests) {
    try { await t.fn(); results.push({ id: t.id, clause: t.clause, status: 'passed', message: null }); }
    catch (e) { results.push({ id: t.id, clause: t.clause, status: 'failed', message: String(e && e.message || e).slice(0, 500) }); }
  }
  return { suite: SUITE, results, warnings: [] };
}

main().then(out => console.log(JSON.stringify(out)))
  .catch(e => console.log(JSON.stringify({ toolError: 'Review clause harness failed: ' + (e && e.message || String(e)) })));
