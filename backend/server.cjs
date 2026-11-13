// Local development only: auto-signs with disposable Hardhat accounts.
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const hre = require('hardhat');
const { BrowserProvider, ContractFactory, Contract, getAddress, MaxUint256 } = require('ethers');
const { milestoneArtifact } = require('../scripts/compile.cjs');
const { createGeneration, fields } = require('./generation.cjs');
const { createOperations } = require('./operations.cjs');
const CHAIN_ID = 31337;

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
async function createServer({ generation: generationOptions, operations: operationsOptions } = {}) {
  const provider = new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  if (hre.network.name !== 'hardhat' || BigInt(await provider.send('eth_chainId', [])) !== BigInt(CHAIN_ID))
    throw new Error('The local signing backend requires the in-process Hardhat chain (31337)');
  const client = await provider.getSigner(0), developer = await provider.getSigner(1);
  const accounts = { clientWallet: await client.getAddress(), developerWallet: await developer.getAddress() };
  const compiled = milestoneArtifact();
  const projects = new Map();
  const deployments = new Map();
  const generation = createGeneration(generationOptions);
  const operations = createOperations(operationsOptions);
  // The reference build has its own identity and entry point.
  const referenceHash = 'sha256:' + createHash('sha256').update(compiled.bytecode).digest('hex');
  function agreement(p, context = generation.context(p)) {
    const deployment = deployments.get(p.id);
    const { abi, ...metadata } = deployment ?? {};
    return { ...context, deployment: deployment ? metadata : null, operationsEnabled: operations.enabled };
  }
  function readTerms(b) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120) fail(400, 'Project name must contain 1–120 characters');
    let a, d;
    try { a = getAddress(b.clientWallet); d = getAddress(b.developerWallet); } catch { fail(400, 'Invalid wallet address'); }
    if (a !== accounts.clientWallet || d !== accounts.developerWallet) fail(400, 'Use the local demo accounts. External wallets are not supported in this mode.');
    return { name: b.name.trim(), clientWallet: a, developerWallet: d, ...readMilestones(b.milestones) };
  }
  // All projects use the same disposable signer, so serialize its transactions.
  let busy = false;
  const hostnames = new Set(['127.0.0.1', 'localhost']);
  async function snapshot(p) {
    if (!p.contractAddress) return { ...p };
    const contract = new Contract(p.contractAddress, deployments.get(p.id).abi, client);
    const blockTag = await provider.send('eth_blockNumber', []);
    const milestones = await Promise.all(p.milestones.map(async m => ({ ...m,
      amountWei: (await contract.milestoneAmount(m.id, { blockTag })).toString(),
      paid: await contract.isPaid(m.id, { blockTag })
    })));
    return { ...p, milestones,
      clientWallet: await contract.client({ blockTag }), developerWallet: await contract.provider({ blockTag }),
      totalAmountWei: (await contract.totalAmount({ blockTag })).toString(),
      funded: await contract.funded({ blockTag }),
      escrowBalanceWei: BigInt(await provider.send('eth_getBalance', [p.contractAddress, blockTag])).toString() };
  }
  // Sends one state-changing call with the local client signer and returns its receipt.
  async function transact(p, action, milestoneId) {
    const c = new Contract(p.contractAddress, deployments.get(p.id).abi, client);
    const tx = action === 'deposit' ? await c.deposit({ value: BigInt(p.totalAmountWei) }) : await c.acceptMilestone(milestoneId);
    return tx.wait();
  }
  const record = (p, action, milestoneId, receipt) => p.transactions.push({ action, ...(action === 'acceptMilestone' ? { milestoneId } : {}),
    hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status });
  async function deploy(p, artifact, terms, kind, runId, sourceHash) {
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, client);
    const contract = await factory.deploy(terms.clientWallet, terms.developerWallet, terms.milestones.map(m => BigInt(m.amountWei)));
    const receipt = await contract.deploymentTransaction().wait();
    if (receipt?.status !== 1 || !receipt.contractAddress) fail(409, 'Deployment was not confirmed');
    p.contractAddress = receipt.contractAddress;
    deployments.set(p.id, { kind, runId, chainId: CHAIN_ID, contractAddress: p.contractAddress,
      sourceHash, specVersion: terms.specVersion, abi: artifact.abi });
    record(p, 'deploy', undefined, receipt);
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
      if (req.method === 'GET' && path === '/api/local-accounts') return send(200, { ...accounts, chainId: CHAIN_ID, mode: 'local-chain' });
      if (req.method === 'POST' && path === '/api/projects') {
        const b = await body(req);
        const terms = readTerms(b);
        const p = { schemaVersion: 2, id: randomUUID(), ...terms, contractAddress: null, escrowBalanceWei: '0', funded: false,
          createdAt: new Date().toISOString(), transactions: [] };
        projects.set(p.id, p); return send(201, p);
      }
      const ai = path.match(/^\/api\/projects\/([^/]+)\/(agreement|confirmation|terms|generation-runs)(?:\/([^/]+))?(\/deployment)?$/);
      if (ai) {
        const p = projects.get(ai[1]);
        if (!p) fail(404, 'Project not found. Local projects reset when the backend restarts.');
        const [, , resource, runId, deploymentRoute] = ai;
        if (deploymentRoute) {
          if (resource !== 'generation-runs' || !runId) fail(404, 'Endpoint not found');
          if (req.method !== 'POST') fail(405, 'Method not allowed');
          const candidate = generation.deploymentCandidate(p, runId, await body(req));
          const existing = deployments.get(p.id);
          if (existing?.kind === 'generated' && existing.runId === runId) return send(200, await snapshot(p));
          if (existing) fail(409, 'This project already has a deployed contract');
          if (busy) fail(409, 'Another transaction is in progress; retry after it completes');
          busy = true;
          try {
            await deploy(p, candidate.artifact, candidate.spec, 'generated', runId, candidate.artifact.sourceHash);
            return send(201, await snapshot(p));
          } finally { busy = false; }
        }
        if (runId) {
          if (resource === 'generation-runs' && req.method === 'GET') return send(200, generation.getRun(p, runId));
          fail(404, 'Endpoint not found');
        }
        if (resource === 'agreement' && req.method === 'GET') return send(200, agreement(p));
        if (resource === 'confirmation' && req.method === 'POST') return send(200, agreement(p, generation.confirm(p, await body(req))));
        if (resource === 'terms' && req.method === 'PUT') {
          const b = await body(req); fields(b, ['expectedSpecVersion', 'draft']);
          fields(b.draft, ['name', 'clientWallet', 'developerWallet', 'milestones']);
          if (busy) fail(409, 'A transaction is in progress; wait before editing rules');
          return send(200, agreement(p, generation.replaceTerms(p, readTerms(b.draft), b.expectedSpecVersion)));
        }
        if (resource === 'generation-runs' && req.method === 'POST') {
          const b = await body(req);
          if (busy) fail(409, 'A transaction is in progress; retry after it completes');
          const started = generation.start(p, b);
          return send(started.replay ? 200 : 202, started.run);
        }
        fail(405, 'Method not allowed');
      }
      const op = path.match(/^\/api\/projects\/([^/]+)\/plans(?:\/([^/]+)\/confirmation)?$/);
      if (op) {
        const p = projects.get(op[1]);
        if (!p) fail(404, 'Project not found. Local projects reset when the backend restarts.');
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        const b = await body(req);
        if (!p.contractAddress) fail(409, 'Deploy the contract first');
        if (busy) fail(409, 'Another transaction is in progress; retry after it completes');
        if (!op[2]) {
          const { kind, runId, ...deployment } = deployments.get(p.id);
          return send(200, await operations.plan(p, b, deployment, await snapshot(p)));
        }
        const stored = operations.take(p, op[2], b);
        busy = true;
        try {
          operations.recheck(p, stored, CHAIN_ID, await snapshot(p));
          const { action, milestoneId } = stored.intent;
          let receipt = null;
          try { receipt = await transact(p, action, milestoneId); }
          catch (e) {
            if (e.code !== 'CALL_EXCEPTION') throw e;
            receipt = e.receipt ?? null; // A rejected call has no receipt; a mined revert has status 0.
          }
          receipt = receipt && { hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status };
          if (receipt?.status === 1) record(p, action, milestoneId, receipt);
          const project = await snapshot(p);
          return send(200, { report: await operations.report(p, stored, receipt, project), project });
        } finally { busy = false; }
      }
      const m = path.match(/^\/api\/projects\/([^/]+)(?:\/actions)?$/);
      if (!m) fail(404, 'Endpoint not found');
      const p = projects.get(m[1]);
      if (!p) fail(404, 'Project not found. Local projects reset when the backend restarts.');
      if (req.method === 'GET' && !path.endsWith('/actions')) return send(200, await snapshot(p));
      if (req.method !== 'POST' || !path.endsWith('/actions')) fail(405, 'Method not allowed');
      const { action, milestoneId } = await body(req);
      if (deployments.get(p.id)?.kind === 'generated') fail(409, 'Use a confirmed operation plan for this generated contract');
      if (!['deploy', 'deposit', 'acceptMilestone'].includes(action)) fail(400, 'Unknown action');
      if (action === 'acceptMilestone' && (!Number.isInteger(milestoneId) || milestoneId < 1 || milestoneId > p.milestones.length)) fail(400, 'Invalid milestone ID');
      if (action !== 'acceptMilestone' && milestoneId !== undefined) fail(400, 'This action does not take a milestone ID');
      if (busy) fail(409, 'Another transaction is in progress; retry after it completes');
      busy = true;
      try {
        let receipt;
        if (action === 'deploy') {
          if (p.contractAddress) fail(409, 'Already deployed');
          await deploy(p, compiled, generation.context(p).spec, 'reference', null, referenceHash);
        } else {
          if (!p.contractAddress) fail(409, 'Deploy first');
          receipt = await transact(p, action, milestoneId);
          if (receipt.status !== 1) fail(409, 'Transaction reverted');
          record(p, action, milestoneId, receipt);
        }
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
