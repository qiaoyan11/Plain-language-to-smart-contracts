const hre = require('hardhat');
const { BrowserProvider, ContractFactory } = require('ethers');
const { artifact } = require('./compile.cjs');

async function setup() {
  const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const client = await provider.getSigner(0);
  const payee = await provider.getSigner(1);
  const outsider = await provider.getSigner(2);
  const a = artifact();
  const factory = new ContractFactory(a.abi, a.bytecode, client);
  const contract = await factory.deploy(await client.getAddress(), await payee.getAddress());
  await contract.waitForDeployment();
  return { provider, client, payee, outsider, contract, factory };
}

async function balance(provider, address) {
  return BigInt(await provider.send('eth_getBalance', [address, 'latest']));
}
module.exports = { setup, balance };
