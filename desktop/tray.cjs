const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function trayIdentity(root) {
  const bytes = crypto.createHash('sha256').update(root).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function trayImage(nativeImage, directory, platform) {
  const file = path.join(directory, platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
  const image = nativeImage.createFromBuffer(fs.readFileSync(file));
  if (image.isEmpty()) throw new Error('The menu bar image could not be loaded.');
  if (platform === 'darwin') {
    image.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(directory, 'trayTemplate@2x.png')) });
    image.setTemplateImage(true);
  }
  return image;
}
function menuBarHidden(bounds, displays) {
  return bounds.width <= 0 || !displays.some(display => bounds.x + bounds.width > display.bounds.x && bounds.x < display.bounds.x + display.bounds.width);
}
module.exports = { trayIdentity, trayImage, menuBarHidden };
