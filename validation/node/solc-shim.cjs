// Minimal solc CLI emulation so Slither (crytic-compile) analyses with the same pinned npm solc 0.8.28.
// Supports only --version and --combined-json. Imports are confined to the working directory.
'use strict';
const path = require('node:path'); const fs = require('node:fs');
const solc = require(process.env.SOLC_JS_PATH || 'solc');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('solc, the solidity compiler commandline interface\nVersion: ' + solc.version());
  process.exit(0);
}
const base = path.resolve(process.cwd());
function read(p) {
  const full = path.resolve(base, p);
  if (!full.startsWith(base + path.sep)) return { error: 'Import outside working directory refused: ' + p };
  try { return { contents: fs.readFileSync(full, 'utf8') }; } catch { return { error: 'File not found: ' + p }; }
}
const i = args.indexOf('--combined-json');
if (i < 0) { console.error('solc-shim: unsupported arguments ' + JSON.stringify(args)); process.exit(2); }
const skip = new Set([i, i + 1]);
args.forEach((a, k) => { if (a === '--allow-paths') { skip.add(k); skip.add(k + 1); } });
const files = args.filter((a, k) => !skip.has(k) && !a.startsWith('--'));
const settings = JSON.parse(process.env.SOLC_SHIM_SETTINGS || '{}');
const input = { language: 'Solidity',
  sources: Object.fromEntries(files.map(f => { const r = read(f); if (r.error) { console.error(r.error); process.exit(1); } return [f, { content: r.contents }]; })),
  settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.sourceMap', 'evm.deployedBytecode.object', 'evm.deployedBytecode.sourceMap', 'userdoc', 'devdoc', 'evm.methodIdentifiers'], '': ['ast'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: read }));
const errors = (out.errors || []).filter(e => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
const contracts = {};
for (const [file, cs] of Object.entries(out.contracts || {})) for (const [name, c] of Object.entries(cs)) {
  contracts[file + ':' + name] = { abi: c.abi, bin: c.evm.bytecode.object, 'bin-runtime': c.evm.deployedBytecode.object,
    srcmap: c.evm.bytecode.sourceMap || '', 'srcmap-runtime': c.evm.deployedBytecode.sourceMap || '',
    userdoc: c.userdoc, devdoc: c.devdoc, hashes: c.evm.methodIdentifiers };
}
const sourceList = Object.keys(out.sources).sort((a, b) => out.sources[a].id - out.sources[b].id);
const sources = Object.fromEntries(Object.entries(out.sources).map(([f, s]) => [f, { AST: s.ast, id: s.id }]));
process.stdout.write(JSON.stringify({ contracts, sourceList, sources, version: solc.version() }));
