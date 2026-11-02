const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const local = path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python = process.env.PYTHON_BIN || (fs.existsSync(local)?local:'python3');
const result=spawnSync(python,['-m','unittest','discover','-s','tests','-p','handoff_test.py','-v'],{cwd:root,stdio:'inherit'});
if(result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
