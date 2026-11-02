// Local development only: auto-signs with disposable Hardhat accounts.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const hre = require('hardhat');
const { BrowserProvider, ContractFactory, Contract, getAddress, parseEther, formatEther } = require('ethers');
const { artifact } = require('../scripts/compile.cjs');

async function createServer() {
  const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const client = await provider.getSigner(0), developer = await provider.getSigner(1);
  const accounts = { clientWallet: await client.getAddress(), developerWallet: await developer.getAddress() };
  const compiled = artifact();
  const projects = new Map();
  const busy = new Set();
  const hostnames = new Set(['127.0.0.1', 'localhost']);
  async function snapshot(p) {
    if (!p.contractAddress) return { ...p };
    const contract = new Contract(p.contractAddress, compiled.abi, client);
    const state = Number(await contract.state());
    const wei = BigInt(await provider.send('eth_getBalance', [p.contractAddress, 'latest']));
    return { ...p, escrowBalance: Number(formatEther(wei)), escrowBalanceWei: wei.toString(),
      deposited: state >= 1, paid: { stage1: state >= 2, stage2: state >= 3 }, chainState: state };
  }
  function fail(status, message) { throw Object.assign(new Error(message), { status }); }
  async function body(req) {
    let data = '';
    for await (const chunk of req) { data += chunk; if (data.length > 16384) fail(413, 'Request too large'); }
    try { return JSON.parse(data || '{}'); } catch { fail(400, 'Invalid JSON'); }
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      // Reject foreign hosts/origins; never expose this auto-signing server publicly.
      if (!hostnames.has(new URL(`http://${req.headers.host}`).hostname)) fail(403, 'Local host required');
      if (req.headers.origin && !hostnames.has(new URL(req.headers.origin).hostname)) fail(403, 'Local origin required');
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/local-accounts') return send(200, { ...accounts, chainId: 31337, mode: 'local-chain' });
      if (req.method === 'POST' && path === '/api/projects') {
        const b = await body(req);
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120) fail(400, 'Project name must contain 1–120 characters');
        let a, d;
        try { a = getAddress(b.clientWallet); d = getAddress(b.developerWallet); } catch { fail(400, 'Invalid wallet address'); }
        if (a !== accounts.clientWallet || d !== accounts.developerWallet) fail(400, 'Use the local demo accounts. External wallets are not supported in this mode.');
        const p = { id: randomUUID(), name: b.name.trim(), clientWallet: a, developerWallet: d,
          totalEth: 0.01, contractAddress: null, escrowBalance: 0, deposited: false,
          paid: { stage1: false, stage2: false }, createdAt: new Date().toISOString(), transactions: [] };
        projects.set(p.id, p); return send(201, p);
      }
      const m = path.match(/^\/api\/projects\/([^/]+)(?:\/actions)?$/);
      if (!m) fail(404, 'Endpoint not found');
      const p = projects.get(m[1]);
      if (!p) fail(404, 'Project not found. Local projects reset when the backend restarts.');
      if (req.method === 'GET' && !path.endsWith('/actions')) return send(200, await snapshot(p));
      if (req.method !== 'POST' || !path.endsWith('/actions')) fail(405, 'Method not allowed');
      const { action } = await body(req);
      if (!['deploy', 'deposit', 'stage1', 'stage2'].includes(action)) fail(400, 'Unknown action');
      if (busy.has(p.id)) fail(409, 'Another transaction is in progress');
      busy.add(p.id);
      try {
        let receipt;
        if (action === 'deploy') {
          if (p.contractAddress) fail(409, 'Already deployed');
          const c = await new ContractFactory(compiled.abi, compiled.bytecode, client).deploy(p.clientWallet, p.developerWallet);
          receipt = await c.deploymentTransaction().wait();
          if (receipt.status !== 1) fail(409, 'Deployment reverted');
          p.contractAddress = await c.getAddress();
        } else {
          if (!p.contractAddress) fail(409, 'Deploy first');
          const c = new Contract(p.contractAddress, compiled.abi, client);
          const tx = action === 'deposit' ? await c.deposit({ value: parseEther('0.01') }) :
            action === 'stage1' ? await c.approveFirst() : await c.approveSecond();
          receipt = await tx.wait();
          if (receipt.status !== 1) fail(409, 'Transaction reverted');
        }
        p.transactions.push({ action, hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status });
        return send(200, await snapshot(p));
      } finally { busy.delete(p.id); }
    } catch (e) {
      send(e.status || (e.code === 'CALL_EXCEPTION' ? 409 : 500), { error: e.status ? e.message : e.code === 'CALL_EXCEPTION' ? 'Contract rejected this action. Check funding, payment order and duplicate payments.' : 'Local chain error; see backend console.' });
      if (!e.status && e.code !== 'CALL_EXCEPTION') console.error(e);
    }
  });
  return server;
}
if (require.main === module) createServer().then(server => server.listen(3001, '127.0.0.1', () => {
  console.log('Local EVM API: http://127.0.0.1:3001 — disposable test accounts only; restart resets projects.');
})).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { createServer };
