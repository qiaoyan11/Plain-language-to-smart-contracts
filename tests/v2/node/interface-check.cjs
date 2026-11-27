// Which IMilestoneReviewEscrow functions and events a recompiled contract ABI lacks.
// Input (stdin): {abi, buildSettings}. Output (stdout): {missing: [signature...]}.
// The interface comes from the trusted repository copy, never from the bundle.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const root = path.resolve(__dirname, '../../..');
const read = name => fs.readFileSync(path.join(root, 'contracts', name), 'utf8');
function signature(item) {
  const types = list => (list || []).map(x => x.type).join(',');
  if (item.type === 'function') return `function ${item.name}(${types(item.inputs)}) returns (${types(item.outputs)}) ${item.stateMutability}`;
  if (item.type === 'event') return `event ${item.name}(${(item.inputs || []).map(x => x.type + (x.indexed ? ' indexed' : '')).join(',')})`;
  return null;
}
try {
  const { abi, buildSettings } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
    'IMilestoneEscrow.sol': { content: read('IMilestoneEscrow.sol') },
    'IMilestoneReviewEscrow.sol': { content: read('IMilestoneReviewEscrow.sol') } },
  settings: { ...buildSettings, outputSelection: { '*': { '*': ['abi'] } } } })));
  const iface = out.contracts?.['IMilestoneReviewEscrow.sol']?.IMilestoneReviewEscrow;
  if (!iface) throw new Error('trusted interface failed to compile');
  const have = new Set(abi.map(signature).filter(Boolean));
  console.log(JSON.stringify({ missing: iface.abi.map(signature).filter(s => s && !have.has(s)) }));
} catch (e) { console.log(JSON.stringify({ toolError: 'Interface check failed: ' + (e && e.message || String(e)) })); }
