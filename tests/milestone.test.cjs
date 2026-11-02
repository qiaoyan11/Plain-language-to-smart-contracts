const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { BrowserProvider, ContractFactory, ZeroAddress, parseEther } = require('ethers');
const { compile } = require('../scripts/compile.cjs');
const { balance } = require('../scripts/local.cjs');

const sources = Object.fromEntries(['IMilestoneEscrow.sol', 'MilestoneEscrow.sol'].map(name => [name, {
  content: fs.readFileSync(path.join(__dirname, '../contracts', name), 'utf8')
}]));
const compiled = compile(sources)['MilestoneEscrow.sol'].MilestoneEscrow;
const gas = { gasLimit: 1500000 };
const values = ['0.003', '0.007', '0.002', '0.004', '0.001'].map(parseEther);
const sum = amounts => amounts.reduce((a, b) => a + b, 0n);
async function mined(tx) { return (await tx).wait(); }

async function context() {
  const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const client = await provider.getSigner(0);
  const payee = await provider.getSigner(1);
  const outsider = await provider.getSigner(2);
  const factory = new ContractFactory(compiled.abi, '0x' + compiled.evm.bytecode.object, client);
  return { provider, client, payee, outsider, factory };
}
async function setup(amounts = values.slice(0, 3)) {
  const ctx = await context();
  const contract = await ctx.factory.deploy(await ctx.client.getAddress(), await ctx.payee.getAddress(), amounts);
  await contract.waitForDeployment();
  return { ...ctx, contract, amounts };
}
async function snapshot(c, provider) {
  const count = Number(await c.milestoneCount());
  return {
    funded: await c.funded(), total: await c.totalAmount(),
    amounts: await Promise.all(Array.from({ length: count }, (_, i) => c.milestoneAmount(i + 1))),
    paid: await Promise.all(Array.from({ length: count }, (_, i) => c.isPaid(i + 1))),
    escrowBalance: await balance(provider, await c.getAddress()),
    recipientBalance: await balance(provider, await c.provider())
  };
}
async function rejectedReceipt(send) {
  let failure;
  try { await mined(send()); } catch (e) { failure = e; }
  assert.ok(failure, 'Expected rejection');
  assert.equal(failure.code, 'CALL_EXCEPTION', 'Must be an EVM rejection');
  assert.ok(failure.receipt, 'Must have a mined revert receipt, not just an estimation error');
  assert.equal(failure.receipt.status, 0);
  assert.equal(failure.receipt.logs.length, 0, 'Reverted events must not survive');
}
async function rejected(send, c, provider, { recipientPaysGas = false } = {}) {
  const before = await snapshot(c, provider);
  await rejectedReceipt(send);
  const after = await snapshot(c, provider);
  // Unauthorized calls from the recipient burn their own gas, but transfer no escrow funds.
  if (recipientPaysGas) {
    assert.ok(after.recipientBalance < before.recipientBalance);
    delete before.recipientBalance;
    delete after.recipientBalance;
  }
  assert.deepEqual(after, before, 'Failed transactions must preserve all escrow state and funds');
}


// Error names belong to this reference implementation, not generated-contract validation.
async function rejectedCall(method, args, c, provider, errorName, options) {
  await assert.rejects(() => method.staticCall(...args),
    e => e.code === 'CALL_EXCEPTION' && e.revert?.name === errorName,
    `Expected ${errorName} before submitting the transaction`);
  await rejected(() => method(...args), c, provider, options);
}

for (const count of [1, 2, 3, 5]) {
  test(`${count} milestones: exact payments, one-based getters and events through completion`, async () => {
    const { contract: c, provider: p, client, payee, amounts } = await setup(values.slice(0, count));
    const receiver = await payee.getAddress();
    const initial = await balance(p, receiver);
    assert.equal(await c.client(), await client.getAddress());
    assert.equal(await c.provider(), receiver);
    assert.equal(await c.totalAmount(), sum(amounts));
    assert.equal(await c.milestoneCount(), BigInt(count));
    assert.equal(await c.funded(), false);
    for (let id = 1; id <= count; id++) {
      assert.equal(await c.milestoneAmount(id), amounts[id - 1]);
      assert.equal(await c.isPaid(id), false);
    }
    const deposit = await mined(c.deposit({ value: sum(amounts) }));
    assert.equal(deposit.status, 1);
    const event = c.interface.parseLog(deposit.logs[0]);
    assert.equal(event.name, 'Deposited');
    assert.equal(event.args.client, await client.getAddress());
    assert.equal(event.args.amount, sum(amounts));
    let released = 0n;
    for (let id = 1; id <= count; id++) {
      const receipt = await mined(c.acceptMilestone(id));
      assert.equal(receipt.status, 1);
      const paid = c.interface.parseLog(receipt.logs[0]);
      assert.equal(paid.name, 'MilestonePaid');
      assert.equal(paid.args.id, BigInt(id));
      assert.equal(paid.args.provider, receiver);
      assert.equal(paid.args.amount, amounts[id - 1]);
      released += amounts[id - 1];
      assert.equal(await c.funded(), true);
      for (let j = 1; j <= count; j++) assert.equal(await c.isPaid(j), j <= id);
      assert.equal(await balance(p, await c.getAddress()), sum(amounts) - released);
      assert.equal(await balance(p, receiver) - initial, released);
    }
  });
}

const invalidConfigurations = [
  ['0 milestones', [], 'valid'],
  ['6 milestones', Array(6).fill(1n), 'valid'],
  ['zero first amount', [0n, 1n], 'valid'],
  ['zero later amount', [1n, 0n], 'valid'],
  ['zero client', [1n], 'zero-client'],
  ['zero provider', [1n], 'zero-provider'],
  ['identical parties', [1n], 'same']
];
for (const [label, amounts, kind] of invalidConfigurations) {
  test(`constructor rejects ${label} with a real reverted receipt`, async () => {
    const { factory, client, payee } = await context();
    const a = await client.getAddress(), b = await payee.getAddress();
    await rejectedReceipt(async () => {
      const c = await factory.deploy(kind === 'zero-client' ? ZeroAddress : a,
        kind === 'zero-provider' ? ZeroAddress : kind === 'same' ? a : b, amounts, gas);
      return c.deploymentTransaction();
    });
  });
}

test('only client may deposit and accept every milestone', async () => {
  const { contract: c, provider: p, outsider, payee, amounts } = await setup();
  for (const actor of [outsider, payee]) {
    await rejectedCall(c.connect(actor).deposit, [{ ...gas, value: sum(amounts) }], c, p, 'Unauthorized',
      { recipientPaysGas: actor === payee });
  }
  await mined(c.deposit({ value: sum(amounts) }));
  for (let id = 1; id <= amounts.length; id++) {
    for (const actor of [outsider, payee]) {
      await rejectedCall(c.connect(actor).acceptMilestone, [id, gas], c, p, 'Unauthorized',
        { recipientPaysGas: actor === payee });
    }
    await mined(c.acceptMilestone(id));
  }
});

test('zero, under and over deposits revert; exact deposit works afterward', async () => {
  const { contract: c, provider: p, amounts } = await setup();
  for (const value of [0n, sum(amounts) - 1n, sum(amounts) + 1n]) {
    await rejectedCall(c.deposit, [{ ...gas, value }], c, p, 'IncorrectDeposit');
  }
  await mined(c.deposit({ value: sum(amounts) }));
  assert.equal(await c.funded(), true);
  assert.equal(await balance(p, await c.getAddress()), sum(amounts));
});

test('funding is required and later milestones cannot skip ahead', async () => {
  const { contract: c, provider: p, amounts } = await setup();
  for (let id = 1; id <= amounts.length; id++) await rejectedCall(c.acceptMilestone, [id, gas], c, p, 'InvalidState');
  await mined(c.deposit({ value: sum(amounts) }));
  await rejectedCall(c.acceptMilestone, [2, gas], c, p, 'InvalidState');
  await rejectedCall(c.acceptMilestone, [3, gas], c, p, 'InvalidState');
  await mined(c.acceptMilestone(1));
  await rejectedCall(c.acceptMilestone, [3, gas], c, p, 'InvalidState');
  await mined(c.acceptMilestone(2));
  await mined(c.acceptMilestone(3));
});

test('no repeated deposit or payment, including after completion', async () => {
  const { contract: c, provider: p, amounts } = await setup();
  await mined(c.deposit({ value: sum(amounts) }));
  for (let id = 1; id <= amounts.length; id++) {
    await rejectedCall(c.deposit, [{ ...gas, value: sum(amounts) }], c, p, 'InvalidState');
    await mined(c.acceptMilestone(id));
    await rejectedCall(c.acceptMilestone, [id, gas], c, p, 'InvalidState');
  }
  await rejectedCall(c.deposit, [{ ...gas, value: sum(amounts) }], c, p, 'InvalidState');
  for (let id = 1; id <= amounts.length; id++) await rejectedCall(c.acceptMilestone, [id, gas], c, p, 'InvalidState');
});

test('out-of-range IDs reject reads and mined writes', async () => {
  const { contract: c, provider: p, amounts } = await setup();
  await mined(c.deposit({ value: sum(amounts) }));
  for (const id of [0, amounts.length + 1]) {
    // View calls are eth_call, not transactions; mutations below require mined receipts.
    await assert.rejects(c.milestoneAmount(id), e => e.code === 'CALL_EXCEPTION');
    await assert.rejects(c.isPaid(id), e => e.code === 'CALL_EXCEPTION');
    await rejected(() => c.acceptMilestone(id, gas), c, p);
  }
});

test('recipient rejection rolls back payment and sequence at every milestone; retries succeed', async () => {
  const { client, provider: p, factory } = await context();
  const output = compile({ 'MilestoneReceiver.sol': { content: `
    // SPDX-License-Identifier: MIT
    pragma solidity 0.8.28;
    contract MilestoneReceiver {
      bool public blocked = true;
      function setBlocked(bool value) external { blocked = value; }
      receive() external payable { require(!blocked, "reject payment"); }
    }` } });
  const a = output['MilestoneReceiver.sol'].MilestoneReceiver;
  const receiver = await new ContractFactory(a.abi, '0x' + a.evm.bytecode.object, client).deploy();
  await receiver.waitForDeployment();
  const amounts = values.slice(0, 3);
  const c = await factory.deploy(await client.getAddress(), await receiver.getAddress(), amounts);
  await c.waitForDeployment();
  await mined(c.deposit({ value: sum(amounts) }));
  let paid = 0n;
  for (let id = 1; id <= amounts.length; id++) {
    await mined(receiver.setBlocked(true));
    await rejected(() => c.acceptMilestone(id, gas), c, p);
    assert.equal(await c.isPaid(id), false);
    await mined(receiver.setBlocked(false));
    await mined(c.acceptMilestone(id, gas));
    paid += amounts[id - 1];
    assert.equal(await c.isPaid(id), true);
    assert.equal(await balance(p, await receiver.getAddress()), paid);
    assert.equal(await balance(p, await c.getAddress()), sum(amounts) - paid);
  }
});

test('forced ETH cannot replace an authorized deposit', async () => {
  const { contract: c, provider: p, client } = await setup(values.slice(0, 2));
  const output = compile({ 'Force.sol': { content: `
    // SPDX-License-Identifier: MIT
    pragma solidity 0.8.28;
    contract Force {
      constructor(address payable to) payable { selfdestruct(to); }
    }` } });
  const a = output['Force.sol'].Force;
  const force = await new ContractFactory(a.abi, '0x' + a.evm.bytecode.object, client)
    .deploy(await c.getAddress(), { value: parseEther('0.01') });
  assert.equal((await force.deploymentTransaction().wait()).status, 1);
  assert.equal(await balance(p, await c.getAddress()), parseEther('0.01'));
  assert.equal(await c.funded(), false);
  assert.equal(await c.isPaid(1), false);
  await rejectedCall(c.acceptMilestone, [1, gas], c, p, 'InvalidState');
  assert.equal(await c.funded(), false);
  assert.equal(await c.isPaid(1), false);
  assert.equal(await balance(p, await c.getAddress()), parseEther('0.01'));
});

test('malicious recipient callback reverts the entire payment and its event', async () => {
  const { client, provider: p, factory } = await context();
  const output = compile({ 'ReentrantReceiver.sol': { content: `
    // SPDX-License-Identifier: MIT
    pragma solidity 0.8.28;
    interface Target { function acceptMilestone(uint256 id) external; }
    contract ReentrantReceiver {
      Target public target;
      bool public entered;
      function setTarget(address escrow) external { target = Target(escrow); }
      receive() external payable {
        if (!entered) {
          entered = true;
          target.acceptMilestone(2);
        }
      }
    }` } });
  const a = output['ReentrantReceiver.sol'].ReentrantReceiver;
  const receiver = await new ContractFactory(a.abi, '0x' + a.evm.bytecode.object, client).deploy();
  await receiver.waitForDeployment();
  const amounts = values.slice(0, 2);
  const c = await factory.deploy(await client.getAddress(), await receiver.getAddress(), amounts);
  await c.waitForDeployment();
  await mined(receiver.setTarget(await c.getAddress()));
  await mined(c.deposit({ value: sum(amounts) }));
  // The callback targets the next valid ID, so onlyClient must reject the receiver.
  // Its uncaught rejection makes the outer transfer fail and rolls back both contracts.
  await rejectedCall(c.acceptMilestone, [1, gas], c, p, 'TransferFailed');
  assert.equal(await receiver.entered(), false);
  assert.equal(await c.funded(), true);
  assert.equal(await c.isPaid(1), false);
  assert.equal(await c.isPaid(2), false);
  assert.equal(await balance(p, await receiver.getAddress()), 0n);
  assert.equal(await balance(p, await c.getAddress()), sum(amounts));
});
