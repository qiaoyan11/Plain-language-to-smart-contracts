// Local development only: auto-signs with disposable Hardhat accounts.
const http = require('node:http');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const hre = require('hardhat');
const { BrowserProvider, ContractFactory, Contract, getAddress, MaxUint256 } = require('ethers');
const { milestoneArtifact } = require('../scripts/compile.cjs');
const { createGeneration, fields } = require('./generation.cjs');
const { createOperations } = require('./operations.cjs');
const { createDrafting } = require('./drafting.cjs');
const { readSavedGeneration, verifySavedGeneration, latestLocalGenerations } = require('./saved-generation.cjs');
const { openStateStore } = require('./state-store.cjs');
const { openLocalChain } = require('./local-chain.cjs');
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
async function createServer(options = {}) {
  const store = options.stateDirectory ? openStateStore(options.stateDirectory) : null;
  try {
    const server = await buildServer(options, store);
    if (store) {
      server.once('close', store.close);
      server.once('error', () => { if (!server.listening) store.close(); });
    }
    return server;
  } catch (error) { store?.close(); throw error; }
}
async function buildServer({ generation: generationOptions, operations: operationsOptions, drafting: draftingOptions,
  savedGeneration, importLegacy = false }, store) {
  const saved = store?.saved;
  const chain = store ? await openLocalChain(saved?.chain ?? null) : null;
  const provider = chain?.provider ?? new BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  if (hre.network.name !== 'hardhat' || BigInt(await provider.send('eth_chainId', [])) !== BigInt(CHAIN_ID))
    throw new Error('The local signing backend requires the in-process Hardhat chain (31337)');
  const client = await provider.getSigner(0), developer = await provider.getSigner(1);
  const accounts = { clientWallet: await client.getAddress(), developerWallet: await developer.getAddress() };
  const compiled = milestoneArtifact();
  const projects = new Map(saved?.projects), deployments = new Map(saved?.deployments);
  const draftOrigins = new Map(saved?.draftOrigins), recoveredProjectIds = new Set(saved?.recoveredProjectIds);
  let committedChain = chain?.chainState(), storageFailure = null, closed = false;
  const generation = createGeneration({ ...generationOptions, saved: saved?.generation, onChange: persist });
  const operations = createOperations(operationsOptions);
  const drafting = createDrafting({ ...draftingOptions, saved: saved?.drafts, onChange: persist });
  function persist() {
    if (!store || closed) return;
    if (storageFailure) fail(503, 'Local storage is unavailable. Changes cannot be confirmed.');
    try {
      store.write({ chain: committedChain, projects: [...projects], deployments: [...deployments],
        draftOrigins: [...draftOrigins], recoveredProjectIds: [...recoveredProjectIds],
        drafts: drafting.exportState(), generation: generation.exportState() });
    } catch (error) { storageFailure = error; throw error; }
  }
  // The reference build has its own identity and entry point.
  const referenceHash = 'sha256:' + createHash('sha256').update(compiled.bytecode).digest('hex');
  function agreement(p, context = generation.context(p)) {
    const deployment = deployments.get(p.id);
    const { abi, ...metadata } = deployment ?? {};
    return { ...context, ...(draftOrigins.has(p.id) ? { draftOrigin: draftOrigins.get(p.id) } : {}),
      ...(recoveredProjectIds.has(p.id) ? { recoveredOnFreshChain: true } : {}),
      deployment: deployment ? metadata : null, operationsEnabled: operations.enabled };
  }
  function readTerms(b) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120) fail(400, 'Project name must contain 1–120 characters');
    let a, d;
    try { a = getAddress(b.clientWallet); d = getAddress(b.developerWallet); } catch { fail(400, 'Invalid wallet address'); }
    if (a !== accounts.clientWallet || d !== accounts.developerWallet) fail(400, 'Use the local demo accounts. External wallets are not supported in this mode.');
    return { name: b.name.trim(), clientWallet: a, developerWallet: d, ...readMilestones(b.milestones) };
  }
  function newProject(terms, id = randomUUID()) {
    return { schemaVersion: 2, id, ...terms, contractAddress: null, escrowBalanceWei: '0', funded: false,
      createdAt: new Date().toISOString(), transactions: [] };
  }
  function importGeneration(savedGeneration) {
    verifySavedGeneration(savedGeneration);
    const spec = savedGeneration.request.payload.spec;
    const project = newProject(readTerms(spec), spec.projectId);
    generation.restore(project, savedGeneration);
    recoveredProjectIds.add(project.id);
    projects.set(project.id, project);
  }
  if (saved) {
    // A stale deployment address or a receipt from a different local chain must not appear usable.
    for (const [id, project] of projects) {
      const deployment = deployments.get(id);
      if (project.id !== id || (project.contractAddress ?? null) !== (deployment?.contractAddress ?? null)
          || Boolean(project.contractAddress) !== project.transactions.some(tx => tx.action === 'deploy'))
        throw new Error('Saved project and deployment records disagree.');
      for (const tx of project.transactions) {
        const receipt = await provider.getTransactionReceipt(tx.hash);
        const address = tx.action === 'deploy' ? receipt?.contractAddress : receipt?.to;
        if (receipt?.status !== 1 || receipt.blockNumber !== tx.blockNumber || address !== project.contractAddress)
          throw new Error('Saved transaction could not be verified on the restored local chain.');
      }
    }
  } else if (savedGeneration !== undefined || importLegacy) {
    if (BigInt(await provider.send('eth_blockNumber', [])) !== 0n)
      throw new Error('A saved generation can only be restored on a fresh local chain.');
    if (savedGeneration !== undefined) importGeneration(savedGeneration);
    else {
      let archives = [];
      try { archives = latestLocalGenerations(); }
      catch { console.warn('Skipped legacy import: archive order could not be verified.'); }
      for (const name of archives) {
        try { importGeneration(readSavedGeneration(name)); }
        catch { console.warn(`Skipped incomplete or ineligible legacy Agent 2 archive ${name}.`); }
      }
    }
  }
  const sealed = p => draftOrigins.has(p.id) || recoveredProjectIds.has(p.id);
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
    try {
      const tx = action === 'deposit' ? await c.deposit({ value: BigInt(p.totalAmountWei) }) : await c.acceptMilestone(milestoneId);
      const receipt = await tx.wait();
      await commitReceipt(p, action, milestoneId, receipt);
      return receipt;
    } catch (error) { await captureRevert(p, action, milestoneId, error); throw error; }
  }
  const record = (p, action, milestoneId, receipt) => p.transactions.push({ action, ...(action === 'acceptMilestone' ? { milestoneId } : {}),
    hash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status });
  async function captureRevert(p, action, milestoneId, error) {
    if (!chain) return;
    const hash = error.transactionHash ?? error.info?.error?.data?.txHash;
    const receipt = error.receipt ?? (hash ? await provider.getTransactionReceipt(hash) : null);
    if (receipt?.status === 0) await commitReceipt(p, action, milestoneId, receipt);
  }
  async function commitReceipt(p, action, milestoneId, receipt, deployment) {
    if (chain) {
      try { await chain.captureMined(receipt); }
      catch (error) { storageFailure = error; throw error; }
    }
    if (receipt.status === 1) {
      if (deployment) { p.contractAddress = receipt.contractAddress; deployments.set(p.id, deployment); }
      record(p, action, milestoneId, receipt);
    }
    if (chain) committedChain = chain.chainState();
    persist(); // The signed block and its project record become visible in the same disk write.
  }
  async function deploy(p, artifact, terms, kind, runId, sourceHash) {
    try {
      const factory = new ContractFactory(artifact.abi, artifact.bytecode, client);
      const contract = await factory.deploy(terms.clientWallet, terms.developerWallet, terms.milestones.map(m => BigInt(m.amountWei)));
      const receipt = await contract.deploymentTransaction().wait();
      if (receipt?.status !== 1 || !receipt.contractAddress) fail(409, 'Deployment was not confirmed');
      await commitReceipt(p, 'deploy', undefined, receipt, { kind, runId, chainId: CHAIN_ID,
        contractAddress: receipt.contractAddress, sourceHash, specVersion: terms.specVersion, abi: artifact.abi });
    } catch (error) { await captureRevert(p, 'deploy', undefined, error); throw error; }
  }
  async function body(req, limit = 16384) {
    let data = '';
    for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > limit) fail(413, 'Request too large'); }
    try {
      const parsed = JSON.parse(data || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Expected a JSON object');
      return parsed;
    } catch { fail(400, 'Invalid JSON object'); }
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => {
      if (req.method !== 'GET' && code < 400) persist();
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
    };
    try {
      if (storageFailure) fail(503, 'The local backend could not verify or save its state. Check the backend log.');
      if (!hostnames.has(new URL(`http://${req.headers.host}`).hostname)) fail(403, 'Local host required');
      if (req.headers.origin && !hostnames.has(new URL(req.headers.origin).hostname)) fail(403, 'Local origin required');
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/local-accounts') return send(200, { ...accounts, chainId: CHAIN_ID, mode: 'local-chain' });
      if (req.method === 'GET' && path === '/api/drafts/context')
        return send(200, { clarificationEnabled: drafting.enabled, mode: 'local-chain', ...accounts });
      if (req.method === 'POST' && path === '/api/drafts') return send(201, drafting.create(await body(req)));
      const dr = path.match(/^\/api\/drafts\/([^/]+)(?:\/(messages|confirmation))?$/);
      if (dr) {
        const [, id, resource] = dr;
        if (req.method === 'GET' && !resource) return send(200, drafting.get(id));
        if (req.method === 'POST' && resource === 'messages') return send(200, await drafting.message(id, await body(req, 100000)));
        if (req.method === 'POST' && resource === 'confirmation') {
          const candidate = drafting.confirmationCandidate(id, await body(req));
          if (candidate.projectId) {
            const p = projects.get(candidate.projectId);
            return send(200, { project: await snapshot(p), agreement: agreement(p) });
          }
          const terms = readTerms(candidate.spec);
          const p = newProject(terms);
          const context = generation.confirm(p, { specVersion: 1, approved: true });
          projects.set(p.id, p);
          draftOrigins.set(p.id, { draftId: id, revision: drafting.get(id).revision });
          drafting.markConfirmed(id, p.id);
          return send(201, { project: p, agreement: agreement(p, context) });
        }
        fail(405, 'Method not allowed');
      }
      if (req.method === 'POST' && path === '/api/projects') {
        const b = await body(req);
        const terms = readTerms(b);
        const p = newProject(terms);
        projects.set(p.id, p); return send(201, p);
      }
      const ai = path.match(/^\/api\/projects\/([^/]+)\/(agreement|confirmation|terms|generation-runs)(?:\/([^/]+))?(\/deployment)?$/);
      if (ai) {
        const p = projects.get(ai[1]);
        if (!p) fail(404, 'Project not found in this local workspace.');
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
          if (sealed(p)) fail(409, 'This project keeps its confirmed source agreement. Start a new draft to change it.');
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
      const known = path.match(/^\/api\/projects\/([^/]+)\/action-plans$/);
      if (known) {
        const p = projects.get(known[1]);
        if (!p) fail(404, 'Project not found in this local workspace.');
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        if (!p.contractAddress) fail(409, 'Deploy the contract first');
        if (busy) fail(409, 'Another transaction is in progress; retry after it completes');
        return send(200, operations.planKnown(p, await body(req), deployments.get(p.id), await snapshot(p)));
      }
      const op = path.match(/^\/api\/projects\/([^/]+)\/plans(?:\/([^/]+)\/confirmation)?$/);
      if (op) {
        const p = projects.get(op[1]);
        if (!p) fail(404, 'Project not found in this local workspace.');
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
          const project = await snapshot(p);
          return send(200, { report: await operations.report(p, stored, receipt, project), project });
        } finally { busy = false; }
      }
      const m = path.match(/^\/api\/projects\/([^/]+)(?:\/actions)?$/);
      if (!m) fail(404, 'Endpoint not found');
      const p = projects.get(m[1]);
      if (!p) fail(404, 'Project not found in this local workspace.');
      if (req.method === 'GET' && !path.endsWith('/actions')) return send(200, await snapshot(p));
      if (req.method !== 'POST' || !path.endsWith('/actions')) fail(405, 'Method not allowed');
      const { action, milestoneId } = await body(req);
      if (sealed(p)) fail(409, 'Use validated generation and confirmed operation plans for this agreement');
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
        }
        return send(200, await snapshot(p));
      } finally { busy = false; }
    } catch (e) {
      send(e.status || (e.code === 'CALL_EXCEPTION' ? 409 : 500), { error: e.status ? e.message : e.code === 'CALL_EXCEPTION' ? 'Contract rejected this action. Check funding, payment order and duplicate payments.' : 'Local chain error; see backend console.' });
      if (!e.status && e.code !== 'CALL_EXCEPTION') console.error(e);
    }
  });
  server.once('close', () => { closed = true; });
  persist();
  return server;
}
if (require.main === module) {
  const port = Number(process.env.LOCAL_API_PORT ?? 3001);
  Promise.resolve().then(() => {
    const name = process.env.LOCAL_RECOVER_GENERATION;
    return createServer({ stateDirectory: process.env.LOCAL_STATE_DIR || path.resolve(__dirname, '../data/private/local-demo'),
      importLegacy: true, ...(name ? { savedGeneration: readSavedGeneration(name) } : {}) });
  }).then(server => server.listen(port, '127.0.0.1', () => {
    console.log(`Local EVM API: http://127.0.0.1:${server.address().port} — local projects and test-chain receipts saved on disk.`);
  })).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { createServer };
