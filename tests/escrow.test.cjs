const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseEther, ContractFactory, ZeroAddress } = require('ethers');
const { setup, balance } = require('../scripts/local.cjs');
const { compile } = require('../scripts/compile.cjs');
const eth = parseEther;

async function mined(tx) { return (await tx).wait(); }

// Send actual reverting transactions, rather than accepting an RPC/estimation failure.
async function rejected(tx, contract, provider, expectedState, expectedBalance) {
  let failure;
  try { await mined(tx); } catch (e) { failure = e; }
  assert.ok(failure, 'Expected rejection');
  assert.equal(failure.code, 'CALL_EXCEPTION', 'Must be an EVM rejection');
  assert.equal(failure.receipt.status, 0, 'Reverted receipt required');
  assert.equal(Number(await contract.state()), expectedState);
  assert.equal(await balance(provider, await contract.getAddress()), eth(expectedBalance));
}
const gas = { gasLimit: 300000 };

test('exact payments and states, with payment events', async () => {
  const { contract, provider, payee } = await setup();
  const before = await balance(provider, await payee.getAddress());
  assert.equal(Number(await contract.state()), 0);
  await mined(contract.deposit({ value: eth('0.01') }));
  assert.equal(Number(await contract.state()), 1);
  const first = await mined(contract.approveFirst());
  assert.equal(first.status, 1);
  const event = contract.interface.parseLog(first.logs[0]);
  assert.equal(event.name, 'MilestonePaid');
  assert.equal(event.args.milestone, 1n);
  assert.equal(event.args.amount, eth('0.003'));
  assert.equal(Number(await contract.state()), 2);
  assert.equal(await balance(provider, await contract.getAddress()), eth('0.007'));
  assert.equal((await balance(provider, await payee.getAddress())) - before, eth('0.003'));
  await mined(contract.approveSecond());
  assert.equal(Number(await contract.state()), 3);
  assert.equal(await balance(provider, await contract.getAddress()), 0n);
  assert.equal((await balance(provider, await payee.getAddress())) - before, eth('0.01'));
});

test('non-client cannot deposit or approve either stage', async () => {
  const { contract: c, provider: p, outsider } = await setup();
  const other = c.connect(outsider);
  await rejected(other.deposit({ ...gas, value: eth('0.01') }), c, p, 0, '0');
  await mined(c.deposit({ value: eth('0.01') }));
  await rejected(other.approveFirst(gas), c, p, 1, '0.01');
  await mined(c.approveFirst());
  await rejected(other.approveSecond(gas), c, p, 2, '0.007');
});

test('underpayment and overpayment rejected; correct deposit succeeds afterward', async () => {
  const { contract: c, provider: p } = await setup();
  for (const value of ['0', '0.009', '0.011']) {
    await rejected(c.deposit({ ...gas, value: eth(value) }), c, p, 0, '0');
  }
  await mined(c.deposit({ value: eth('0.01') }));
  assert.equal(Number(await c.state()), 1);
});

test('no payment before funding and no second payment before first', async () => {
  const { contract: c, provider: p } = await setup();
  await rejected(c.approveFirst(gas), c, p, 0, '0');
  await rejected(c.approveSecond(gas), c, p, 0, '0');
  await mined(c.deposit({ value: eth('0.01') }));
  await rejected(c.approveSecond(gas), c, p, 1, '0.01');
});

test('no duplicate deposit or payment, including after completion', async () => {
  const { contract: c, provider: p } = await setup();
  await mined(c.deposit({ value: eth('0.01') }));
  await rejected(c.deposit({ ...gas, value: eth('0.01') }), c, p, 1, '0.01');
  await mined(c.approveFirst());
  await rejected(c.approveFirst(gas), c, p, 2, '0.007');
  await mined(c.approveSecond());
  await rejected(c.approveSecond(gas), c, p, 3, '0');
  await rejected(c.approveFirst(gas), c, p, 3, '0');
  await rejected(c.deposit({ ...gas, value: eth('0.01') }), c, p, 3, '0');
});

test('zero or identical participant addresses rejected', async () => {
  const { factory, client, payee } = await setup();
  const a = await client.getAddress(), b = await payee.getAddress();
  for (const pair of [[ZeroAddress, b], [a, ZeroAddress], [a, a]]) {
    await assert.rejects(async () => {
      const deployed = await factory.deploy(...pair, gas);
      await deployed.waitForDeployment();
    }, e => e.code === 'CALL_EXCEPTION');
  }
});

test('failed recipient transfer rolls back state and funds at both stages', async () => {
  const { client, provider: p, factory } = await setup();
  const compiled = compile({ 'Receiver.sol': { content: `
    // SPDX-License-Identifier: MIT
    pragma solidity 0.8.28;
    contract Receiver {
      bool public blocked = true;
      function setBlocked(bool value) external { blocked = value; }
      receive() external payable { require(!blocked, "reject payment"); }
    }` } });
  const a = compiled['Receiver.sol'].Receiver;
  const receiver = await new ContractFactory(a.abi, '0x' + a.evm.bytecode.object, client).deploy();
  await receiver.waitForDeployment();
  const c = await factory.deploy(await client.getAddress(), await receiver.getAddress());
  await c.waitForDeployment();
  await mined(c.deposit({ value: eth('0.01') }));
  await rejected(c.approveFirst(gas), c, p, 1, '0.01');
  await mined(receiver.setBlocked(false));
  await mined(c.approveFirst(gas));
  await mined(receiver.setBlocked(true));
  await rejected(c.approveSecond(gas), c, p, 2, '0.007');
  assert.equal(await balance(p, await receiver.getAddress()), eth('0.003'));
  await mined(receiver.setBlocked(false));
  await mined(c.approveSecond(gas));
  assert.equal(await balance(p, await receiver.getAddress()), eth('0.01'));
});
