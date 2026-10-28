// SVG is the editable source; deterministic PNGs feed both native packagers.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const directory = path.join(__dirname, '..', 'desktop', 'assets');
const icon = fs.readFileSync(path.join(directory, 'icon.svg'), 'utf8');
const wave = '<path d="M0 11.8C5 11.8 6 6.2 10 6.2S15 12.2 18 12.2C20 12.2 21 9.8 22 8.8" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round"/>';
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 18">${wave}</svg>`;
for (const [name, svg, width] of [['icon.png', icon, 1024], ['tray.png', icon, 64], ['trayTemplate.png', tray, 22], ['trayTemplate@2x.png', tray, 44]]) {
  const render = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  fs.writeFileSync(path.join(directory, name), render.render().asPng());
}
