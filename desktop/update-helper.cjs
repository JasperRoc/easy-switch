// Runs from the private update cache, independently of the app being replaced.
process.noAsar = true;
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function replaceApplication({ current, staged, verify, launch, accepted }) {
  const directory = fs.mkdtempSync(path.join(path.dirname(current), '.easy-switch-update-'));
  const candidate = path.join(directory, 'next.app'), backup = path.join(directory, 'previous.app');
  let replaced = false, child;
  try {
    fs.cpSync(staged, candidate, { recursive: true, dereference: false, verbatimSymlinks: true });
    verify(candidate);
    fs.renameSync(current, backup);
    try { fs.renameSync(candidate, current); replaced = true; } catch (error) { fs.renameSync(backup, current); throw error; }
    child = launch(current);
    if (!await accepted(child)) throw new Error('The updated application did not confirm startup.');
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await delay(600); }
    if (replaced) { fs.rmSync(current, { recursive: true, force: true }); fs.renameSync(backup, current); launch(current); }
    throw error;
  } finally { if (!fs.existsSync(backup)) fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { replaceApplication };
if (require.main === module) (async () => {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.send?.({ ready: true });
  const install = await new Promise(resolve => { process.once('message', message => resolve(!!message?.install)); process.once('disconnect', () => resolve(false)); });
  if (!install) return;
  const deadline = Date.now() + 60000;
  while (true) {
    try { process.kill(job.parent, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    if (Date.now() > deadline) throw new Error('The previous application did not exit.');
    await delay(200);
  }
  const environment = { ...process.env, ...job.environment }; delete environment.ELECTRON_RUN_AS_NODE;
  const launch = application => { const child = spawn(path.join(application, 'Contents', 'MacOS', 'easy-switch'), [], { detached: true, stdio: 'ignore', env: environment }); child.on('error', () => {}); child.unref(); return child; };
  await replaceApplication({ ...job,
    verify: application => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { stdio: 'pipe' }), launch,
    accepted: async child => {
      for (let n = 0; n < 150; n++) {
        try { const receipt = JSON.parse(fs.readFileSync(job.receipt, 'utf8')); if (receipt.ready && receipt.token === job.token) return true; } catch {}
        if (child.exitCode !== null || child.signalCode !== null) return false;
        await delay(200);
      }
      child.kill('SIGKILL'); await delay(600); return false;
    },
  });
  fs.rmSync(job.receipt, { force: true }); if (job.archive) fs.rmSync(job.archive, { force: true }); fs.rmSync(path.dirname(job.staged), { recursive: true, force: true });
})().catch(error => {
  try { fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'last-error.txt'), error.message, { mode: 0o600 }); } catch {}
  process.exitCode = 1;
});
