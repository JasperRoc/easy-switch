import { atCapacity } from './failover.js';

// Hold only the startup preamble. Once any output/tool event is accepted, pass
// bytes through unchanged and never replay the request.
export async function inspectStartup(stream) {
  const reader = stream.getReader(), chunks = [], decoder = new TextDecoder();
  let buffered = '', inspected = 0;
  const passthrough = () => new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
    async pull(controller) {
      try { const { done, value } = await reader.read(); if (done) controller.close(); else controller.enqueue(value); }
      catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  try {
    while (inspected < 65536) {
      const { done, value } = await reader.read();
      if (done) return { stream: passthrough() };
      chunks.push(value);
      const prefix = value.subarray(0, 65536 - inspected); inspected += prefix.length;
      buffered += decoder.decode(prefix, { stream: true });
      let end;
      while ((end = /\r?\n\r?\n/.exec(buffered))) {
        const record = buffered.slice(0, end.index); buffered = buffered.slice(end.index + end[0].length);
        const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) { if (/^event:/m.test(record)) return { stream: passthrough() }; continue; }
        let event;
        try { event = JSON.parse(data); } catch { return { stream: passthrough() }; }
        const type = event?.type || record.match(/^event:\s*(.*)$/m)?.[1].trim();
        if (event?.response?.output?.length) return { stream: passthrough() };
        if (['error', 'response.failed'].includes(type)) {
          return { stream: passthrough(), capacity: atCapacity(data) };
        }
        if (!['response.created', 'response.in_progress', 'response.queued'].includes(type)) return { stream: passthrough() };
      }
    }
    return { stream: passthrough() };
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}
