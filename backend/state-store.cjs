const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// When a process started, on Linux: a container restart reuses small process ids, so a lease
// names its writer by id and start time. Elsewhere only the id is known.
function startTime(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] || null; }
  catch { return null; }
}
// Each contender announces itself before looking for a live writer. Dead process leases
// can be removed by name without touching a replacement writer's unique lease.
function openStateStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'state.json');
  const started = startTime(process.pid);
  const lease = `writer-${process.pid}-${started ? `s${started}-` : ''}${randomUUID()}.lock`;
  const leasePath = path.join(directory, lease);
  fs.closeSync(fs.openSync(leasePath, 'wx', 0o600));
  let closed = false;
  function close() {
    if (!closed) {
      closed = true;
      fs.rmSync(leasePath, { force: true });
    }
  }
  try {
    for (const name of fs.readdirSync(directory)) {
      const match = /^writer-(\d+)-(?:s(\d+)-)?[a-f\d-]+\.lock$/.exec(name);
      if (!match || name === lease) continue;
      let alive = true;
      try { process.kill(Number(match[1]), 0); }
      catch (e) {
        if (e.code !== 'ESRCH') throw e;
        alive = false;
      }
      // The same id with another start time is a different process: the writer is gone.
      if (alive && match[2] && startTime(Number(match[1])) !== match[2]) alive = false;
      if (!alive) {
        fs.rmSync(path.join(directory, name), { force: true });
        continue;
      }
      throw new Error('Another backend is using this local data directory.');
    }
    const exists = fs.existsSync(filename);
    const saved = exists ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
    if (exists && (saved?.format !== 1 || !saved.chain || !Array.isArray(saved.projects)
        || !Array.isArray(saved.deployments) || !Array.isArray(saved.draftOrigins)
        || !Array.isArray(saved.recoveredProjectIds) || !Array.isArray(saved.drafts)
        || !saved.generation || !['agreements', 'runs', 'keys'].every(k => Array.isArray(saved.generation[k]))))
      throw new Error('Invalid local state file. Original data has been preserved.');
    function write(state) {
      if (closed) throw new Error('Local state writer is closed.');
      const temp = path.join(directory, `state-${randomUUID()}.tmp`);
      try {
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ format: 1, ...state })); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temp, filename);
        if (process.platform !== 'win32') {
          const dir = fs.openSync(directory, 'r');
          try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        }
      } finally { fs.rmSync(temp, { force: true }); }
    }
    return { saved, write, close };
  } catch (e) { close(); throw e; }
}

module.exports = { openStateStore };
