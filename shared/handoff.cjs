// Node independently checks the same schema even if a replacement worker forgets.
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { createHash } = require('node:crypto');
const schema = require('./schemas/handoff.schema.json');
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const kinds = ['Response', 'DraftSpec', 'ConfirmedSpec', 'ClarifyResult', 'GenerateResult', 'PlanResult', 'ReportInput', 'ReportResult'];
const validators = Object.fromEntries(kinds.map(kind => [kind, ajv.compile({ ...schema, $ref: `#/$defs/${kind}` })]));
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function check(kind, data) { requireThat(validators[kind](data), `INVALID_${kind}: ${ajv.errorsText(validators[kind].errors)}`); }
function checkSpec(spec, complete = false) {
  check(complete ? 'ConfirmedSpec' : 'DraftSpec', spec);
  const addresses = [spec.clientWallet, spec.developerWallet].filter(Boolean).map(a => a.toLowerCase());
  requireThat(!addresses.includes('0x' + '0'.repeat(40)) && new Set(addresses).size === addresses.length, 'INVALID_PARTICIPANTS');
  requireThat(spec.milestones.every((m, i) => m.id === i + 1), 'INVALID_MILESTONE_ORDER');
  const amounts = spec.milestones.filter(m => m.amountWei !== null).map(m => BigInt(m.amountWei));
  const max = (1n << 256n) - 1n, sum = amounts.reduce((a, b) => a + b, 0n);
  requireThat(amounts.every(a => a > 0n && a <= max) && sum <= max, 'INVALID_AMOUNTS');
  if (spec.totalAmountWei !== null) {
    const total = BigInt(spec.totalAmountWei);
    requireThat(total > 0n && total <= max, 'INVALID_TOTAL');
    if (amounts.length === spec.milestones.length && amounts.length) requireThat(total === sum, 'TOTAL_MISMATCH');
  }
}
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
}
function receiptOutcome({ projectId, intent, receipt, snapshot }) {
  if (!receipt || projectId !== snapshot.id || intent.projectId !== snapshot.id ||
      snapshot.contractAddress?.toLowerCase() !== intent.contractAddress.toLowerCase()) return 'unverified';
  if (receipt.status === 0) return 'failed';
  const recorded = snapshot.transactions.some(tx =>
    tx.hash.toLowerCase() === receipt.hash.toLowerCase() && tx.blockNumber === receipt.blockNumber &&
    tx.status === receipt.status && tx.action === intent.action && (tx.milestoneId ?? null) === intent.milestoneId);
  if (!recorded || !snapshot.funded) return 'unverified';
  if (intent.action === 'acceptMilestone' && !snapshot.milestones.some(m => m.id === intent.milestoneId && m.paid)) return 'unverified';
  return 'confirmed';
}
function validateResponse(request, response) {
  check('Response', response);
  requireThat(response.requestId === request.requestId, 'INVALID_REQUEST_ID');
  if (response.status === 'error') {
    requireThat(response.result === null && response.errors.length > 0, 'INVALID_ERROR');
    return;
  }
  requireThat(response.errors.length === 0, 'INVALID_ERRORS');
  const kind = { clarify: 'ClarifyResult', generate: 'GenerateResult', planAction: 'PlanResult', reportAction: 'ReportResult' }[request.operation];
  requireThat(kind, 'INVALID_OPERATION');
  check(kind, response.result);
  const result = response.result;
  if (request.operation === 'clarify') {
    checkSpec(result.draftSpec, result.status === 'readyForConfirmation');
    if (request.payload.draftSpec) requireThat(result.draftSpec.projectId === request.payload.draftSpec.projectId, 'DRAFT_PROJECT_MISMATCH');
    if (result.status === 'readyForConfirmation') requireThat(!result.questions.length && !result.unsupportedTerms.length, 'UNRESOLVED_DRAFT');
    const sources = request.payload.history.filter(m => m.role === 'user').map(m => m.content).concat(request.payload.message);
    requireThat((result.separateTerms ?? []).every(term => term.trim() && sources.some(s => s.includes(term))), 'UNSOURCED_SEPARATE_TERM');
  }
  if (request.operation === 'generate') {
    const { sourceBundle: bundle, validationReport: report, attempts } = result;
    const config = request.payload.runConfig;
    requireThat(attempts.length <= config.maxRepairs + 1, 'REPAIR_BUDGET_EXCEEDED');
    requireThat(attempts.every((a, i) => a.attempt === i), 'INVALID_ATTEMPT_ORDER');
    if (bundle) {
      for (const k of ['projectId', 'specVersion']) requireThat(bundle[k] === request.payload.spec[k], 'STALE_RESULT');
      requireThat(Object.hasOwn(bundle.sources, bundle.entryFile), 'MISSING_ENTRY_FILE');
      const keys = ['sources','entryFile','entryContract','compilerVersion','buildSettings','dependencies'];
      const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(keys.map(k => [k,bundle[k]]))))).digest('hex');
      requireThat(hash === bundle.sourceHash, 'SOURCE_HASH_MISMATCH');
      const last = attempts.at(-1);
      requireThat(last && last.sourceHash === bundle.sourceHash && last.reportId === (report?.reportId ?? null), 'ATTEMPT_REPORT_MISMATCH');
    }
    if (report) {
      requireThat(bundle, 'REPORT_WITHOUT_SOURCE');
      for (const k of ['projectId','specVersion','sourceHash']) requireThat(report[k] === bundle[k], 'REPORT_SOURCE_MISMATCH');
      requireThat(new Set(report.checks.map(c => c.name)).size === 3, 'DUPLICATE_CHECKS');
      if (report.status === 'passed') {
        requireThat(report.checks.every(c => c.status === 'passed') && report.artifact, 'INVALID_PASS');
        requireThat(report.artifact.sourceHash === bundle.sourceHash && report.artifact.compilerVersion === bundle.compilerVersion &&
          JSON.stringify(canonical(report.artifact.buildSettings)) === JSON.stringify(canonical(bundle.buildSettings)), 'ARTIFACT_MISMATCH');
      } else requireThat(report.artifact === null, 'UNVALIDATED_ARTIFACT');
    }
    if (result.status === 'validated') requireThat(report?.status === 'passed', 'UNVERIFIED_RESULT');
    if (result.status === 'generated') requireThat(bundle && report === null, 'INVALID_GENERATED_RESULT');
    if (config.validationMode === 'none') requireThat(report === null && result.status !== 'validated', 'VALIDATION_DISABLED');
  }
  if (request.operation === 'planAction') {
    const intent = result.intent;
    requireThat(Boolean(intent) === (result.status === 'readyForConfirmation'), 'INVALID_INTENT');
    if (intent) {
      const { deployment, projectId } = request.payload;
      requireThat(intent.projectId === projectId && intent.chainId === deployment.chainId && intent.contractAddress.toLowerCase() === deployment.contractAddress.toLowerCase(), 'INTENT_DEPLOYMENT_MISMATCH');
      requireThat((intent.milestoneId !== null) === (intent.action === 'acceptMilestone'), 'INVALID_MILESTONE');
    }
  }
  if (request.operation === 'reportAction') {
    check('ReportInput', request.payload);
    const { intent } = request.payload;
    requireThat((intent.milestoneId !== null) === (intent.action === 'acceptMilestone'), 'INVALID_MILESTONE');
    requireThat(result.outcome === receiptOutcome(request.payload), 'REPORT_OUTCOME_MISMATCH');
  }
}
module.exports = { validateResponse, receiptOutcome };
