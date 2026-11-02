#!/usr/bin/env node
// Adversarial test executable selected only by tests through PYTHON_BIN.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.env.BRIDGE_PROBE === 'stubborn') {
  process.on('SIGTERM', () => fs.writeFileSync(process.env.PROBE_FILE + '.term', 'received'));
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'inherit' });
  fs.writeFileSync(process.env.PROBE_FILE, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else {
  let input = '';
  process.stdin.on('data', c => input += c);
  process.stdin.on('end', () => {
    const request = JSON.parse(input);
    console.log(JSON.stringify({interfaceVersion:1,requestId:request.requestId,status:'ok',errors:[],result:{status:'validated'}}));
  });
}
