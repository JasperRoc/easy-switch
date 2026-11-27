import { createInterface } from 'node:readline';

export function serveWorker(
  call: (action: string, payload, context) => unknown,
  { retained = () => false, close, parallel = new Set<string>(), events = false }: {
    retained?: () => boolean;
    close: () => Promise<void> | void;
    parallel?: ReadonlySet<string>;
    events?: boolean;
  },
) {
  const input = createInterface({ input: process.stdin });
  const write = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');
  let previous = false, serial = Promise.resolve();
  const changed = () => {
    const value = retained();
    if (value !== previous) { previous = value; write({ retained: value }); }
  };
  input.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (!Number.isSafeInteger(request?.id) || typeof request.action !== 'string') return;
    const run = async () => {
      try { write({ id: request.id, value: await call(request.action, request.payload, request.context) ?? null }); }
      catch (error) { write({ id: request.id, error: error.message || 'Operation failed.' }); }
      changed();
    };
    if (parallel.has(request.action)) void run();
    else serial = serial.then(run);
  });
  input.once('close', () => { void Promise.resolve(close()).finally(() => process.exit(0)); });
  return () => { changed(); if (events) write({ changed: true }); };
}
