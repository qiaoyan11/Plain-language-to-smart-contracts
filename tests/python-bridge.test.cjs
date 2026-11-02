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
