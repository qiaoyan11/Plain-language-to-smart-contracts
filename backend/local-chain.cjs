// Disk-backed history for the private, in-process Hardhat demo chain. No RPC listener.
const { BrowserProvider, Transaction, toQuantity } = require('ethers');
const hre = require('hardhat');
const { createProvider } = require('hardhat/internal/core/providers/construction');

async function openLocalChain(saved = null) {
  const network = hre.config.networks.hardhat;
  if (hre.network.name !== 'hardhat' || network.chainId !== 31337 || network.forking?.enabled)
    throw new Error('Persistent demo history requires the isolated local Hardhat chain.');
  if (saved !== null && (saved.version !== 1 || !Array.isArray(saved.blocks)
      || typeof saved.initialDate !== 'string' || typeof saved.genesisHash !== 'string'))
    throw new Error('Unrecognized local chain history. The saved state has been preserved.');
  const initialDate = saved?.initialDate ?? new Date().toISOString();
  const config = { ...hre.config, networks: { ...hre.config.networks, hardhat: { ...network, initialDate } } };
  const local = await createProvider(config, 'hardhat', hre.artifacts);
  const provider = new BrowserProvider(local, undefined, { cacheTimeout: -1 });
  const blockAt = number => local.send('eth_getBlockByNumber', [toQuantity(number), false]);
  const genesis = await blockAt(0);
  const history = { version: 1, initialDate, genesisHash: genesis.hash, blocks: [] };
  if (saved && saved.genesisHash !== genesis.hash)
    throw new Error('The saved local chain has a different genesis block.');

  // Reconstruct an isolated EVM from the original signed bytes. A matching block hash
  // commits to its parent, state root, transactions and receipts. Never sign a second payment.
  for (const entry of saved?.blocks ?? []) {
    const number = history.blocks.length + 1;
    const tx = Transaction.from(entry.raw);
    if (tx.chainId !== 31337n || !tx.signature)
      throw new Error(`Invalid signed local transaction at block ${number}.`);
    await local.send('evm_setNextBlockTimestamp', [entry.timestamp]);
    await local.send('hardhat_setPrevRandao', [entry.mixHash]);
    await local.send('eth_sendRawTransaction', [entry.raw]);
    const block = await blockAt(number);
    if (block?.hash !== entry.hash)
      throw new Error(`Could not verify saved local block ${number}. The saved history has been preserved.`);
    history.blocks.push(entry);
  }

  async function captureMined(receipt) {
    const number = receipt.blockNumber;
    if (number <= history.blocks.length && history.blocks[number - 1]?.hash === receipt.blockHash) return;
    if (number !== history.blocks.length + 1) throw new Error('The local chain history is out of sequence.');
    const block = await blockAt(number);
    if (!block || block.hash !== receipt.blockHash || block.transactions.length !== 1
        || block.transactions[0] !== receipt.hash) throw new Error('Could not verify the local mined receipt.');
    const tx = Transaction.from(await provider.getTransaction(receipt.hash));
    if (!tx.signature || tx.hash !== receipt.hash) throw new Error('Could not verify the mined transaction.');
    history.blocks.push({ hash: block.hash, timestamp: block.timestamp, mixHash: block.mixHash, raw: tx.serialized });
  }
  return { provider, captureMined, chainState: () => structuredClone(history) };
}

module.exports = { openLocalChain };
