// Startup-only access to a completed Agent 2 record written by this local installation.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { validateGenerationRequest, validateResponse } = require('../shared/handoff.cjs');

const root = path.resolve(__dirname, '..');
const archiveRoot = path.join(root, 'artifacts', 'agent2');
const runPattern = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

function archiveFile(name, filename) {
  if (!runPattern.test(name))
    throw new Error('LOCAL_RECOVER_GENERATION must name a saved Agent 2 run directory.');
  const file = path.join(archiveRoot, name, filename);
  if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile())
    throw new Error('Expected a regular file within the local Agent 2 run directory.');
  return file;
}
function readSavedGeneration(name) {
  const read = filename => JSON.parse(fs.readFileSync(archiveFile(name, filename), 'utf8'));
  return { request: read('request.json'), response: read('response.json') };
}

function latestLocalGenerations() {
  if (!fs.existsSync(archiveRoot)) return [];
  const latest = new Map();
  for (const name of fs.readdirSync(archiveRoot)) {
    if (!runPattern.test(name)) continue;
    const file = archiveFile(name, 'request.json');
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = request.payload?.spec?.projectId;
    // CLI samples do not represent site-created projects. Include unfinished/failed web
    // runs in ordering so their older passing revisions cannot be offered for deployment.
    if (request.operation !== 'generate' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) continue;
    const time = fs.statSync(file).mtimeMs;
    if (!latest.has(id) || latest.get(id).time < time) latest.set(id, { time, name });
    else if (latest.get(id).time === time) latest.set(id, { time, name: null }); // ambiguous ordering
  }
  return Array.from(latest.values(), run => run.name).filter(Boolean);
}

function verifySavedGeneration(saved) {
  const { request, response } = saved;
  validateGenerationRequest(request);
  validateResponse(request, response);
  if (request.payload.runConfig.validationMode !== 'development' || response.status !== 'ok'
      || response.result.status !== 'validated' || response.result.validationReport?.status !== 'passed')
    throw new Error('Recovery requires a completed generation with passed development checks.');
  const artifact = response.result.validationReport.artifact;
  // Reuse the pinned, self-contained compiler to match the bytes, as well as the source hash.
  const build = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/compile-generated.cjs')], {
    input: JSON.stringify({ request, response }), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  }));
  if (build.status !== 'passed' || build.artifact?.bytecode !== artifact.bytecode
      || !isDeepStrictEqual(build.artifact.abi, artifact.abi))
    throw new Error('Saved deployment artifact does not match the validated Solidity source.');
}

module.exports = { readSavedGeneration, verifySavedGeneration, latestLocalGenerations };
