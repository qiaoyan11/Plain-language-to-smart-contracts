// Smoke compilation only. Not the independently owned validation suite.
// No import callback: generated code cannot read arbitrary files or fetch packages.
const solc = require('solc');
const fs = require('node:fs');
const {validateResponse} = require('../shared/handoff.cjs');
try {
  const input = fs.readFileSync(0);
  if (input.length > 1024 * 1024) throw new Error('Input too large');
  const {request, response} = JSON.parse(input);
  validateResponse(request, response);
  const b = response.result.sourceBundle;
  if (!b || b.compilerVersion !== solc.version().split('+')[0]) throw new Error('Compiler version mismatch');
  const compiled = JSON.parse(solc.compile(JSON.stringify({language:'Solidity',
    sources:Object.fromEntries(Object.entries(b.sources).map(([name,content])=>[name,{content}])),
    settings:{...b.buildSettings,outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
  const diagnostics = (compiled.errors || []).map(e=>({severity:e.severity,code:e.errorCode || null,message:e.formattedMessage}));
  const entry = compiled.contracts?.[b.entryFile]?.[b.entryContract];
  if (!diagnostics.some(e=>e.severity==='error') && !entry?.evm?.bytecode?.object) {
    diagnostics.push({severity:'error',code:'NO_ENTRY_BYTECODE',message:'Expected deployable entry contract is missing.'});
  }
  if (entry?.abi) {
    const types = entry.abi.find(x=>x.type==='constructor')?.inputs.map(x=>x.type);
    if (JSON.stringify(types)!==JSON.stringify(['address','address','uint256[]'])) {
      diagnostics.push({severity:'error',code:'CONSTRUCTOR_MISMATCH',message:'Constructor must take address,address,uint256[].'});
    }
  }
  const passed = !diagnostics.some(e=>e.severity==='error');
  console.log(JSON.stringify({status:passed?'passed':'failed',scope:'compilation-only',sourceHash:b.sourceHash,
    compilerVersion:solc.version(),diagnostics,artifact:passed?{abi:entry.abi,bytecode:'0x'+entry.evm.bytecode.object}:null}));
} catch {
  console.log(JSON.stringify({status:'toolError',scope:'compilation-only',diagnostics:[{severity:'error',code:'COMPILER_TOOL_ERROR',message:'Compiler input or execution failed.'}],artifact:null}));
  process.exitCode=1;
}
