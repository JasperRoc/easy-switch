// Render the approved logo into NSIS artwork. No additional image tools needed.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const directory = path.join(__dirname, '..', 'desktop', 'assets');
const icon = fs.readFileSync(path.join(directory, 'icon.svg'), 'utf8');
const logo = (x, y, size) => icon.replace('<svg ', `<svg x="${x}" y="${y}" `).replace('width="1024" height="1024"', `width="${size}" height="${size}"`);
const artwork = [
  ['installerSidebar', 328, 628, `<defs>
    <linearGradient id="paper" x2=".8" y2="1"><stop stop-color="#f9fcff"/><stop offset="1" stop-color="#e7f0f8"/></linearGradient>
    <linearGradient id="sea" x2="0" y2="1"><stop stop-color="#317db8"/><stop offset="1" stop-color="#003f88"/></linearGradient>
  </defs>
  <rect width="328" height="628" fill="url(#paper)"/>
  <circle cx="276" cy="186" r="154" fill="#fff" opacity=".55"/>
  <text x="36" y="72" fill="#173550" font-size="36" font-family="Segoe UI, Arial, sans-serif" font-weight="600" letter-spacing="-1">easy-switch</text>
  <path d="M36 98h256" stroke="#b8d2e6" stroke-opacity=".55"/>
  ${logo(28, 164, 272)}
  <path d="M0 506C84 506 96 458 166 458S262 514 328 484V628H0Z" fill="url(#sea)" opacity=".12"/>
  <path d="M0 558C82 558 104 506 176 506S268 562 328 536V628H0Z" fill="url(#sea)" opacity=".35"/>
  <path d="M0 590C84 590 108 552 186 552S274 600 328 570V628H0Z" fill="url(#sea)"/>
  <path d="M0 590C84 590 108 552 186 552S274 600 328 570" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="2"/>`],
  ['installerHeader', 300, 114, `<rect width="300" height="114" fill="#fff"/>${logo(202, 9, 96)}
    <path d="M16 82C54 82 66 60 98 60S142 86 180 70" fill="none" stroke="#003f88" stroke-opacity=".12" stroke-width="2"/>`],
];
for (const [name, width, height, content] of artwork) {
  const rendered = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`).render();
  // NSIS expects uncompressed 24-bit BMP, bottom row first, padded to 4 bytes.
  const stride = (width * 3 + 3) & ~3, data = Buffer.alloc(54 + stride * height);
  data.write('BM'); data.writeUInt32LE(data.length, 2); data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14); data.writeInt32LE(width, 18); data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26); data.writeUInt16LE(24, 28); data.writeUInt32LE(stride * height, 34);
  const pixels = rendered.pixels;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, target = 54 + (height - y - 1) * stride + x * 3;
    data[target] = pixels[source + 2]; data[target + 1] = pixels[source + 1]; data[target + 2] = pixels[source];
  }
  fs.writeFileSync(path.join(directory, name + '.bmp'), data);
}
