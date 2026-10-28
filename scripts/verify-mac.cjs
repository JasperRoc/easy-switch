const { execFileSync } = require('node:child_process');
const path = require('node:path');
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const application = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--verify', '--deep', '--strict', application], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', path.join(application, 'Contents', 'Resources', 'codex', 'codex')], { stdio: 'inherit' });
  console.log('Verified macOS application and bundled Codex signatures.');
};
