const assert = require('node:assert/strict');
const { parseEther, formatEther } = require('ethers');
const { setup, balance } = require('./local.cjs');

async function main() {
  const { provider, contract, payee } = await setup();
  const address = await contract.getAddress();
  const initial = await balance(provider, await payee.getAddress());
  const names = ['AwaitingDeposit', 'Funded', 'FirstPaid', 'Completed'];
  const rows = [];
  async function record(step, expectedState, escrow, received) {
    const state = Number(await contract.state());
    const held = await balance(provider, address);
    const paid = (await balance(provider, await payee.getAddress())) - initial;
    assert.equal(state, expectedState);
    assert.equal(held, parseEther(escrow));
    assert.equal(paid, parseEther(received));
    rows.push({ step, state: names[state], escrowETH: formatEther(held), providerReceivedETH: formatEther(paid) });
  }
  console.log('LOCAL SIMULATION ONLY — fresh disposable chain, no wallet or real funds.');
  console.log('Contract:', address);
  await record('Deploy', 0, '0', '0');
  for (const [step, send, state, held, paid] of [
    ['Deposit', () => contract.deposit({ value: parseEther('0.01') }), 1, '0.01', '0'],
    ['Approve homepage', () => contract.approveFirst(), 2, '0.007', '0.003'],
    ['Approve full website', () => contract.approveSecond(), 3, '0', '0.01']
  ]) {
    const receipt = await (await send()).wait();
    assert.equal(receipt.status, 1);
    await record(step, state, held, paid);
  }
  console.table(rows);
  console.log('All amounts and state transitions verified against the local chain.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
