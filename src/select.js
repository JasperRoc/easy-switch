import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

export async function select(title, choices, { input = process.stdin, output = process.stdout, initial = 0, subtitle = '' } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('请在交互终端执行 switch model');
  if (!choices.length) throw new Error('没有可选项');
  let selected = Math.min(Math.max(initial, 0), choices.length - 1);
  const wasRaw = !!input.isRaw, wasFlowing = input.readableFlowing === true;
  const clean = text => stripVTControlCharacters(String(text)).replace(/[\r\n]/g, ' ');
  function draw() {
    const count = Math.max(1, (output.rows || 24) - (subtitle ? 5 : 4));
    const start = Math.max(0, selected - count + 1);
    output.write(`\x1b[H\x1b[2J${clean(title)}\r\n${subtitle ? clean(subtitle) + '\r\n' : ''}↑/↓ 选择 · Enter 确认 · Esc/Ctrl+C 取消\r\n\r\n`);
    for (let i = start; i < Math.min(choices.length, start + count); i++) output.write(`${i === selected ? '>' : ' '} ${clean(choices[i])}\r\n`);
  }
  emitKeypressEvents(input);
  let keypress, cancel;
  try {
    input.setRawMode(true); input.resume();
    output.write('\x1b[?1049h\x1b[?25l'); draw();
    return await new Promise(resolve => {
      cancel = () => resolve(null);
      keypress = (_text, key = {}) => {
        if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name))) return cancel();
        if (key.name === 'return') return resolve(selected);
        if (key.name === 'up') selected = Math.max(0, selected - 1);
        else if (key.name === 'down') selected = Math.min(choices.length - 1, selected + 1);
        else return;
        draw();
      };
      input.on('keypress', keypress); input.once('end', cancel); process.once('SIGTERM', cancel);
    });
  } finally {
    if (keypress) input.removeListener('keypress', keypress);
    if (cancel) { input.removeListener('end', cancel); process.removeListener('SIGTERM', cancel); }
    input.setRawMode(wasRaw); if (!wasFlowing) input.pause();
    output.write('\x1b[?25h\x1b[?1049l');
  }
}
