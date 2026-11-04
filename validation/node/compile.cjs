// Independent recompilation of a SourceBundle with the pinned npm solc.
// Input (stdin): {bundle, interfaceSource}. Output (stdout): one JSON object.
// No import callback: a bundle must be self-contained; it cannot read other files.
'use strict';
const fs = require('node:fs');
const solc = require('solc');

function lineOf(source, offset) {
  if (typeof source !== 'string' || !(offset >= 0)) return null;
  return source.slice(0, offset).split('\n').length;
}

function signature(item) {
  const types = list => (list || []).map(x => x.type).join(',');
  if (item.type === 'function') return `function ${item.name}(${types(item.inputs)}) returns (${types(item.outputs)}) ${item.stateMutability}`;
  if (item.type === 'event') return `event ${item.name}(${(item.inputs || []).map(x => x.type + (x.indexed ? ' indexed' : '')).join(',')})`;
  return null;
}

function compileSources(sources, settings) {
  const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).map(([f, content]) => [f, { content }])),
    settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  return JSON.parse(solc.compile(JSON.stringify(input)));
}

function main() {
  const { bundle, interfaceSource } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const version = solc.version();
  const out = { tool: 'solc-js', solcVersion: version, diagnostics: [], entry: null, constructorTypes: null };
  const finding = (severity, code, message, file = null, line = null) => out.diagnostics.push({ severity, code, message, file, line });

  if (version.split('+')[0] !== bundle.compilerVersion) {
    console.log(JSON.stringify({ toolError: `Installed solc ${version} does not match requested ${bundle.compilerVersion}` }));
    return;
  }
  const compiled = compileSources(bundle.sources, bundle.buildSettings);
  for (const e of compiled.errors || []) {
    const file = e.sourceLocation?.file || null;
    finding(e.severity === 'error' ? 'error' : e.severity, 'SOLC_' + (e.errorCode || e.type || 'DIAGNOSTIC'),
      e.formattedMessage || e.message, file, file ? lineOf(bundle.sources[file], e.sourceLocation.start) : null);
  }
  if (out.diagnostics.some(d => d.severity === 'error')) { console.log(JSON.stringify(out)); return; }

  const entry = compiled.contracts?.[bundle.entryFile]?.[bundle.entryContract];
  if (!entry || !entry.evm?.bytecode?.object) {
    finding('error', 'NO_ENTRY_BYTECODE', `Entry contract ${bundle.entryContract} in ${bundle.entryFile} has no deployable bytecode.`, bundle.entryFile);
    console.log(JSON.stringify(out)); return;
  }
  out.entry = { abi: entry.abi, bytecode: '0x' + entry.evm.bytecode.object, deployedBytecode: '0x' + entry.evm.deployedBytecode.object };
  out.constructorTypes = (entry.abi.find(x => x.type === 'constructor')?.inputs || []).map(x => x.type);
  if (JSON.stringify(out.constructorTypes) !== JSON.stringify(['address', 'address', 'uint256[]'])) {
    finding('error', 'CONSTRUCTOR_MISMATCH', `Constructor types are [${out.constructorTypes}], expected [address,address,uint256[]].`, bundle.entryFile);
  }

  // Interface conformance against the frozen IMilestoneEscrow v1 (trusted copy, not the bundle's).
  const ref = compileSources({ 'IMilestoneEscrow.sol': interfaceSource }, bundle.buildSettings);
  const iface = ref.contracts?.['IMilestoneEscrow.sol']?.IMilestoneEscrow;
  if (!iface) { console.log(JSON.stringify({ toolError: 'Frozen interface failed to compile' })); return; }
  const have = new Set(entry.abi.map(signature).filter(Boolean));
  for (const item of iface.abi) {
    const sig = signature(item);
    if (sig && !have.has(sig)) finding('error', 'INTERFACE_MISMATCH', `Missing or different from IMilestoneEscrow v1: ${sig}`, bundle.entryFile);
  }
  if ('IMilestoneEscrow.sol' in bundle.sources && bundle.sources['IMilestoneEscrow.sol'] !== interfaceSource) {
    finding('error', 'INTERFACE_FILE_MODIFIED', 'Bundled IMilestoneEscrow.sol differs from the frozen interface.', 'IMilestoneEscrow.sol');
  }
  console.log(JSON.stringify(out));
}

try { main(); } catch (e) { console.log(JSON.stringify({ toolError: 'Compiler adapter failed: ' + (e && e.message || String(e)) })); }
