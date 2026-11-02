// Local development only: auto-signs with disposable Hardhat accounts.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const hre = require('hardhat');
const { BrowserProvider, ContractFactory, Contract, getAddress, MaxUint256 } = require('ethers');
const { milestoneArtifact } = require('../scripts/compile.cjs');

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function readMilestones(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) fail(400, 'Provide 1–5 milestones');
  let total = 0n;
  const milestones = value.map((m, index) => {
    if (!m || typeof m.title !== 'string' || !m.title.trim() || m.title.length > 120) fail(400, 'Each milestone needs a title of 1–120 characters');
    if (typeof m.amountWei !== 'string' || !/^[1-9][0-9]{0,77}$/.test(m.amountWei)) fail(400, 'Milestone amounts must be positive integer wei strings');
    total += BigInt(m.amountWei);
    if (total > MaxUint256) fail(400, 'Total amount exceeds the contract limit');
    return { id: index + 1, title: m.title.trim(), amountWei: m.amountWei, paid: false };
  });
  return { milestones, totalAmountWei: total.toString() };
}
async function createServer() {
  const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  const client = await provider.getSigner(0), developer = await provider.getSigner(1);
  const accounts = { clientWallet: await client.getAddress(), developerWallet: await developer.getAddress() };
  const compiled = milestoneArtifact();
  const projects = new Map();
  // All projects use the same disposable signer, so serialize its transactions.
  let busy = false;
  const hostnames = new Set(['127.0.0.1', 'localhost']);
  async function snapshot(p) {
    if (!p.contractAddress) return { ...p };
    const contract = new Contract(p.contractAddress, compiled.abi, client);
    const blockTag = await provider.send('eth_blockNumber', []);
    const milestones = await Promise.all(p.milestones.map(async m => ({ ...m,
      amountWei: (await contract.milestoneAmount(m.id, { blockTag })).toString(),
      paid: await contract.isPaid(m.id, { blockTag })
    })));
    return { ...p, milestones,
      totalAmountWei: (await contract.totalAmount({ blockTag })).toString(),
      funded: await contract.funded({ blockTag }),
      escrowBalanceWei: BigInt(await provider.send('eth_getBalance', [p.contractAddress, blockTag])).toString() };
  }
  async function body(req) {
    let data = '';
    for await (const chunk of req) { data += chunk; if (data.length > 16384) fail(413, 'Request too large'); }
    try {
      const parsed = JSON.parse(data || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Expected a JSON object');
      return parsed;
    } catch { fail(400, 'Invalid JSON object'); }
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
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
        const terms = readMilestones(b.milestones);
        const p = { schemaVersion: 2, id: randomUUID(), name: b.name.trim(), clientWallet: a, developerWallet: d,
          ...terms, contractAddress: null, escrowBalanceWei: '0', funded: false,
          createdAt: new Date().toISOString(), transactions: [] };
        projects.set(p.id, p); return send(201, p);
      }
      const m = path.match(/^\/api\/projects\/([^/]+)(?:\/actions)?$/);
      if (!m) fail(404, 'Endpoint not found');
      const p = projects.get(m[1]);
      if (!p) fail(404, 'Project not found. Local projects reset when the backend restarts.');
      if (req.method === 'GET' && !path.endsWith('/actions')) return send(200, await snapshot(p));
      if (req.method !== 'POST' || !path.endsWith('/actions')) fail(405, 'Method not allowed');
      const { action, milestoneId } = await body(req);
      if (!['deploy', 'deposit', 'acceptMilestone'].includes(action)) fail(400, 'Unknown action');
      if (action === 'acceptMilestone' && (!Number.isInteger(milestoneId) || milestoneId < 1 || milestoneId > p.milestones.length)) fail(400, 'Invalid milestone ID');
      if (action !== 'acceptMilestone' && milestoneId !== undefined) fail(400, 'This action does not take a milestone ID');
      if (busy) fail(409, 'Another transaction is in progress; retry after it completes');
      busy = true;
      try {
        let receipt;
        if (action === 'deploy') {
          if (p.contractAddress) fail(409, 'Already deployed');
          const c = await new ContractFactory(compiled.abi, compiled.bytecode, client)
            .deploy(p.clientWallet, p.developerWallet, p.milestones.map(m => BigInt(m.amountWei)));
          receipt = await c.deploymentTransaction().wait();
          if (receipt.status !== 1) fail(409, 'Deployment reverted');
          p.contractAddress = await c.getAddress();
        } else {
          if (!p.contractAddress) fail(409, 'Deploy first');
          const c = new Contract(p.contractAddress, compiled.abi, client);
          const tx = action === 'deposit' ? await c.deposit({ value: BigInt(p.totalAmountWei) }) : await c.acceptMilestone(milestoneId);
          receipt = await tx.wait();
          if (receipt.status !== 1) fail(409, 'Transaction reverted');
        }
        p.transactions.push({ action, ...(action === 'acceptMilestone' ? { milestoneId } : {}), hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status });
        return send(200, await snapshot(p));
      } finally { busy = false; }
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
