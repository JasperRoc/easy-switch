import { emitKeypressEvents } from 'node:readline';

export async function editOrder(aliases, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('请在交互终端执行 switch order；查看顺序请用 switch list');
  const order = [...aliases];
  if (!order.length) return order;
  let selected = 0;
  const wasRaw = !!input.isRaw;
  const wasPaused = input.isPaused();
  function draw() {
    const count = Math.max(1, (output.rows || 24) - 4);
    const start = Math.max(0, selected - count + 1);
    output.write('\x1b[H\x1b[2J优先级：从高到低\r\n↑/↓ 选择 · Shift+↑/↓ 或 K/J 移动 · Enter 保存 · Esc 取消\r\n\r\n');
    for (let i = start; i < Math.min(order.length, start + count); i++) {
      output.write(`${i === selected ? '>' : ' '} ${i + 1}. ${order[i]}\r\n`);
    }
  }
  emitKeypressEvents(input);
  let keypress;
  let cancel;
  try {
    input.setRawMode(true);
    output.write('\x1b[?1049h\x1b[?25l');
    draw();
    return await new Promise(resolve => {
      cancel = () => resolve(null);
      keypress = (text, key = {}) => {
        if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name))) return cancel();
        if (key.name === 'return') return resolve(order);
        const direction = key.name === 'up' || text === 'K' ? -1 : key.name === 'down' || text === 'J' ? 1 : 0;
        if (!direction) return;
        const next = selected + direction;
        if (next < 0 || next >= order.length) return;
        if (key.shift || text === 'K' || text === 'J') [order[selected], order[next]] = [order[next], order[selected]];
        selected = next;
        draw();
      };
      input.on('keypress', keypress);
      input.once('end', cancel);
      process.once('SIGTERM', cancel);
      input.resume();
    });
  } finally {
    if (keypress) input.removeListener('keypress', keypress);
    if (cancel) { input.removeListener('end', cancel); process.removeListener('SIGTERM', cancel); }
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
    output.write('\x1b[?25h\x1b[?1049l');
  }
}
