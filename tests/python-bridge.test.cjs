const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runPython } = require('../backend/python-bridge.cjs');
const request = require('../shared/examples/generate.request.json');
const clone = () => structuredClone(request);

test('stub handoff: clarification -> fixture confirmation -> generation -> blocked operation', async () => {
  const clarify = await runPython(require('../shared/examples/clarify.request.json'));
  assert.equal(clarify.result.status, 'needsClarification');
  // Explicit test fixture only: no claim that the clarification was user-confirmed.
  const generated = await runPython(clone());
  assert.equal(generated.result.status, 'generated');
  assert.equal(generated.result.validationReport, null);
  assert.ok(generated.result.sourceBundle.sources['MilestoneEscrow.sol']);
  const plan = await runPython(require('../shared/examples/planAction.request.json'));
  assert.equal(plan.result.status, 'blocked');
  assert.equal(plan.result.intent, null);
});
test('development request cannot become passed without validator', async () => {
  const r=clone(); r.payload.runConfig.validationMode='development';
  assert.equal((await runPython(r)).result.status,'toolError');
});
test('invalid input is rejected across language boundary', async () => {
  const r=clone();r.payload.spec.totalAmountWei='1';
  await assert.rejects(runPython(r), /PYTHON_HANDOFF_ERROR/);
});
test('deadline kills the subprocess and releases the slot', async () => {
  await assert.rejects(runPython(clone(),{timeoutMs:1}), /PYTHON_TIMEOUT/);
  assert.equal((await runPython(clone())).status,'ok');
});
test('combined stdout/stderr limit is enforced', async () => {
  await assert.rejects(runPython(clone(),{maxBytes:10}), /PYTHON_OUTPUT_LIMIT/);
});
test('late result is discarded', async () => {
  await assert.rejects(runPython(clone(),{isCurrent:()=>false}), /STALE_RESULT/);
});
test('concurrent run for same project is refused', async () => {
  const first=runPython(clone());
  await assert.rejects(runPython(clone()), /PROJECT_BUSY/);
  await first;
});
test('oversize request is rejected before launch', async () => {
  const r=clone();r.payload.spec.name='x'.repeat(1024*1024);
  await assert.rejects(runPython(r), /INPUT_LIMIT/);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateResponse } = require('../shared/handoff.cjs');
const fakeWorker = path.join(__dirname, 'fixtures/bridge-worker.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('replacement worker cannot return an incomplete validated result', {skip:process.platform === 'win32'}, async () => {
  const previous = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = fakeWorker;
  try { await assert.rejects(runPython(clone()), /INVALID_GenerateResult/); }
  finally { previous === undefined ? delete process.env.PYTHON_BIN : process.env.PYTHON_BIN = previous; }
});

test('repair budget and final report association are checked at Node boundary', async () => {
  const response = await runPython(clone());
  const over = structuredClone(response);
  over.result.attempts.push({...over.result.attempts[0],attempt:1});
  assert.throws(()=>validateResponse(clone(),over), /REPAIR_BUDGET_EXCEEDED/);
  const mismatch = structuredClone(response);
  mismatch.result.attempts[0].reportId = 'unrelated-report';
  assert.throws(()=>validateResponse(clone(),mismatch), /ATTEMPT_REPORT_MISMATCH/);
  const accepted = structuredClone(response);
  accepted.result.attempts.push({...accepted.result.attempts[0],attempt:1});
  const withBudget = clone(); withBudget.payload.runConfig.maxRepairs = 1;
  validateResponse(withBudget,accepted);
});

test('timeout kills stubborn worker and its child before releasing project lock', {skip:process.platform === 'win32'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-cleanup-'));
  const marker = path.join(dir,'pids');
  const previous = {PYTHON_BIN:process.env.PYTHON_BIN,BRIDGE_PROBE:process.env.BRIDGE_PROBE,PROBE_FILE:process.env.PROBE_FILE};
  Object.assign(process.env,{PYTHON_BIN:fakeWorker,BRIDGE_PROBE:'stubborn',PROBE_FILE:marker});
  let pids = [];
  try {
    const pending = assert.rejects(runPython(clone(),{timeoutMs:1000}), /PYTHON_TIMEOUT/);
    const deadline = Date.now()+5000;
    while (!fs.existsSync(marker+'.term') && Date.now()<deadline) await pause(10);
    assert.ok(fs.existsSync(marker+'.term'), 'worker received TERM');
    pids = JSON.parse(fs.readFileSync(marker,'utf8'));
    await assert.rejects(runPython(clone()), /PROJECT_BUSY/);
    await pending;
    for (const pid of pids) {
      const gone = () => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
      for (let n = 0; n < 100 && !gone(); n++) await pause(10);
      assert.ok(gone(), `process ${pid} is still alive`);
    }
  } finally {
    for (const pid of pids) { try {process.kill(pid,'SIGKILL');} catch {} }
    for (const [key,value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key]=value;
    fs.rmSync(dir,{recursive:true,force:true});
  }
  assert.equal((await runPython(clone())).status,'ok');
});

// Validation includes three bounded tools per attempt; keep the bridge alive long enough.
test('live timeout accounts for validation and bounded repair rounds', () => {
  const { defaultTimeout } = require('../backend/python-bridge.cjs');
  const previous = process.env.AGENT2_MODE;
  try {
    delete process.env.AGENT2_MODE;
    assert.equal(defaultTimeout({}), 10000);
    process.env.AGENT2_MODE = 'live';
    assert.equal(defaultTimeout({}), 210000);
    assert.equal(defaultTimeout({operation:'generate',payload:{runConfig:{validationMode:'development',maxRepairs:1}}}), 1800000);
    assert.equal(defaultTimeout({operation:'generate',payload:{runConfig:{validationMode:'development',maxRepairs:999}}}), 5400000);
  } finally {
    if (previous === undefined) delete process.env.AGENT2_MODE;
    else process.env.AGENT2_MODE = previous;
  }
});
