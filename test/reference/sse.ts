import fs from 'node:fs';
import { ReadableStream, type ReadableStreamDefaultReader } from 'node:stream/web';
import { atCapacity } from './failover.js';

const limit = 64 * 1024;
interface Parser extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  chunk_buffer(): number;
  record_buffer(): number;
  data_buffer(): number;
  scan(length: number, offset: number, suffix: number): number;
  extract_data(length: number, first: number): number;
}

const { exports } = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(new URL('./sse.wasm', import.meta.url))));
const parser = exports as Parser;
const chunkBuffer = new Uint8Array(parser.memory.buffer, parser.chunk_buffer(), limit);
const recordBuffer = new Uint8Array(parser.memory.buffer, parser.record_buffer(), limit);
const dataBuffer = new Uint8Array(parser.memory.buffer, parser.data_buffer(), limit);
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

type Body = ReadableStream<Uint8Array>;
type Reader = ReadableStreamDefaultReader<Uint8Array>;
export interface Startup {
  stream: Body;
  capacity?: boolean;
  error?: unknown;
}

export function replayStream(reader: Pick<Reader, 'read' | 'cancel'>, chunks: Uint8Array[]): Body {
  return new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

// Hold only the startup preamble. Once any output/tool event is accepted, pass
// bytes through unchanged and never replay the request.
export async function inspectStartup(stream: Response['body'], preamble = ['response.created', 'response.in_progress', 'response.queued']): Promise<Startup> {
  const reader = stream.getReader() as Reader;
  const chunks: Uint8Array[] = [];
  const fragments: Uint8Array[] = [];
  let inspected = 0, suffix = 0, first = true;
  const passthrough = () => ({ stream: replayStream(reader, chunks) });
  try {
    while (inspected < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      const prefix = value.subarray(0, limit - inspected);
      inspected += prefix.length;
      chunkBuffer.set(prefix);
      let offset = 0;
      // The WASM buffers are shared. Keep parsing between reads synchronous.
      while (offset < prefix.length) {
        const next = parser.scan(prefix.length, offset, suffix);
        if (next < 0) {
          suffix = -1 - next;
          fragments.push(prefix.subarray(offset));
          break;
        }
        let length = 0;
        for (const fragment of fragments) {
          recordBuffer.set(fragment, length);
          length += fragment.length;
        }
        recordBuffer.set(prefix.subarray(offset, next), length);
        length += next - offset;
        fragments.length = 0;
        offset = next;
        suffix = 0;
        // The final two line breaks delimit the record. A CR belongs to a
        // delimiter only immediately before its LF.
        length -= recordBuffer[length - 2] === 13 ? 3 : 2;
        if (recordBuffer[length - 1] === 13) length--;
        const size = parser.extract_data(length, Number(first));
        const hasBOM = first && recordBuffer[0] === 0xef && recordBuffer[1] === 0xbb && recordBuffer[2] === 0xbf;
        first = false;
        if (size < 0) return passthrough();
        if (!size) continue;
        const data = decoder.decode(dataBuffer.subarray(0, size));
        let event;
        try { event = JSON.parse(data); } catch { return passthrough(); }
        const type = event?.type || decoder.decode(recordBuffer.subarray(hasBOM ? 3 : 0, length)).match(/^event:\s*(.*)$/m)?.[1].trim();
        if (event?.response?.output?.length || event?.message?.content?.length) return passthrough();
        if (type === 'error' || type === 'response.failed') {
          return { ...passthrough(), capacity: atCapacity(data), error: event?.error || event?.response?.error || event };
        }
        if (!preamble.includes(type)) return passthrough();
      }
    }
    return passthrough();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}
