// Node independently checks the same schema even if a replacement worker forgets.
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { createHash } = require('node:crypto');
const schema = require('./schemas/handoff.schema.json');
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const kinds = ['Response', 'ClarifyResult', 'GenerateResult', 'PlanResult'];
const validators = Object.fromEntries(kinds.map(kind => [kind, ajv.compile({ ...schema, $ref: `#/$defs/${kind}` })]));
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function check(kind, data) { requireThat(validators[kind](data), `INVALID_${kind}: ${ajv.errorsText(validators[kind].errors)}`); }
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
}
function validateResponse(request, response) {
  check('Response', response);
  requireThat(response.requestId === request.requestId, 'INVALID_REQUEST_ID');
  if (response.status === 'error') {
    requireThat(response.result === null && response.errors.length > 0, 'INVALID_ERROR');
    return;
  }
  requireThat(response.errors.length === 0, 'INVALID_ERRORS');
  const kind = { clarify: 'ClarifyResult', generate: 'GenerateResult', planAction: 'PlanResult' }[request.operation];
  requireThat(kind, 'INVALID_OPERATION');
  check(kind, response.result);
  const result = response.result;
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
}
module.exports = { validateResponse };
