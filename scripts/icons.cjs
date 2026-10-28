const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc(buffer) {
  let n = 0xffffffff;
  for (const b of buffer) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function triangle(x, y, ax, ay, bx, by, cx, cy) {
  const a = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const b = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const c = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  return !((a < 0 || b < 0 || c < 0) && (a > 0 || b > 0 || c > 0));
}
function image(size, template) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / size, py = (y + .5) / size;
    const top = (px >= .25 && px <= .68 && Math.abs(py - .36) < .04) || triangle(px, py, .64, .23, .80, .36, .64, .49);
    const bottom = (px >= .32 && px <= .75 && Math.abs(py - .64) < .04) || triangle(px, py, .36, .51, .20, .64, .36, .77);
    let color = [0, 0, 0, 0];
    if (top || bottom) color = template ? [0, 0, 0, 255] : top ? [242, 250, 251, 255] : [102, 220, 194, 255];
    else if (!template) {
      const dx = Math.max(.22 - px, px - .78, 0), dy = Math.max(.22 - py, py - .78, 0);
      if (dx * dx + dy * dy <= .22 * .22) color = [21 + Math.round(py * 3), 40 + Math.round(py * 19), 61 + Math.round(px * 12), 255];
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4; for (let c = 0; c < 4; c++) raw[offset + c] = color[c];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const directory = path.join(__dirname, '..', 'desktop', 'assets'); fs.mkdirSync(directory, { recursive: true });
for (const [name, size, template] of [['icon.png', 1024, false], ['tray.png', 32, false], ['trayTemplate.png', 36, true]]) fs.writeFileSync(path.join(directory, name), image(size, template));
