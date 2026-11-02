const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const root = path.resolve(__dirname, '..');

function compile(extraSources = {}) {
  const sources = {
    'TwoStageEscrow.sol': {
      content: fs.readFileSync(path.join(root, 'contracts/TwoStageEscrow.sol'), 'utf8')
    },
    ...extraSources
  };
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: {
      evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  })));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return output.contracts;
}

function artifact() {
  const c = compile()['TwoStageEscrow.sol'].TwoStageEscrow;
  return { contractName: 'TwoStageEscrow', compilerVersion: solc.version(),
    abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

if (require.main === module) {
  const out = path.join(root, 'artifacts');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'TwoStageEscrow.json'), JSON.stringify(artifact(), null, 2));
  console.log('Compiled TwoStageEscrow; ABI and bytecode saved in artifacts/TwoStageEscrow.json');
}
module.exports = { compile, artifact };
