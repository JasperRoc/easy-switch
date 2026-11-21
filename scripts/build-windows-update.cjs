const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');

module.exports = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'win32') return;
  const { path: compiler, env } = await getMakeNsisPath(packager.config.toolsets?.nsis, packager.config.nsis?.customNsisBinary);
  const output = path.join(packager.getResourcesDir(appOutDir), 'windows-update.exe');
  const script = path.join(__dirname, 'windows-update.nsi');
  execFileSync(compiler, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', '-DUPDATE_HELPER=' + output, script], {
    env: { ...process.env, ...env }, stdio: 'inherit',
  });
};
