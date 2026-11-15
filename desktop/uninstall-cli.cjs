// Run through Electron's Node mode so cleanup does not open or lock its UI cache.
(async () => {
  const os = require('node:os');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { removeDesktopData } = await import(pathToFileURL(path.join(__dirname, 'uninstall.js')));
  const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
  const parent = Number(argument('--parent'));
  if (parent > 0) {
    const deadline = Date.now() + 30000;
    while (true) {
      try { process.kill(parent, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (Date.now() > deadline) throw new Error('The application did not exit before cleanup.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  const root = path.resolve(argument('--root') || process.env.SWITCH_HOME || path.join(os.homedir(), '.codex-switch'));
  if (require('node:fs').existsSync(root)) await removeDesktopData(root);
  const application = argument('--application');
  if (application && process.platform === 'darwin') {
    if (!application.endsWith('/easy-switch.app')) throw new Error('Unexpected application path.');
    require('node:fs').rmSync(application, { recursive: true, force: true });
  } else if (application && process.platform === 'win32') {
    const uninstaller = path.join(application, 'Uninstall easy-switch.exe');
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const command = `$ErrorActionPreference='Stop'; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }; Start-Process -FilePath ${literal(uninstaller)} -ArgumentList '/S' -Wait`;
    require('node:child_process').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
