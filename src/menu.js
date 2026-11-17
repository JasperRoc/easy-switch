import { emitKeypressEvents } from 'node:readline';

export async function choose(title, options, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('请在交互终端执行 switch，或使用 switch help 查看完整命令');
  let selected = 0, keypress, cancel;
  const wasRaw = !!input.isRaw, wasPaused = input.isPaused();
  const draw = () => {
    const rows = Math.max(1, (output.rows || 24) - 4), start = Math.max(0, selected - rows + 1);
    output.write(`\x1b[H\x1b[2J${title}\r\n↑/↓ 选择 · Enter 确认 · Esc 返回\r\n\r\n`);
    for (let index = start; index < Math.min(options.length, start + rows); index++) output.write(`${index === selected ? '>' : ' '} ${options[index].label}\r\n`);
  };
  emitKeypressEvents(input);
  try {
    input.setRawMode(true); output.write('\x1b[?1049h\x1b[?25l'); draw();
    return await new Promise(resolve => {
      cancel = () => resolve(null);
      keypress = (_text, key = {}) => {
        if (key.name === 'escape' || key.ctrl && ['c', 'd'].includes(key.name)) return cancel();
        if (key.name === 'return') return resolve(options[selected].value);
        if (key.name === 'up') selected = Math.max(0, selected - 1);
        else if (key.name === 'down') selected = Math.min(options.length - 1, selected + 1);
        else return;
        draw();
      };
      input.on('keypress', keypress); input.once('end', cancel); process.once('SIGTERM', cancel); input.resume();
    });
  } finally {
    if (keypress) input.removeListener('keypress', keypress);
    if (cancel) { input.removeListener('end', cancel); process.removeListener('SIGTERM', cancel); }
    input.setRawMode(wasRaw); if (wasPaused) input.pause(); output.write('\x1b[?25h\x1b[?1049l');
  }
}
