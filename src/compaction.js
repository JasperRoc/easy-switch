import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

const prefix = 'easy-switch:v1:';
const key = token => createHash('sha256').update(token).digest();
export const summaryPrompt = 'Create a concise continuation summary of this conversation. Preserve the user’s goal, constraints and instructions, completed changes, file paths, tool results, unresolved issues and next steps. Do not perform new work or call tools. Return only the summary.';

// A portable checkpoint is encrypted locally, independent of the upstream account.
export function checkpoint(summary, token) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(token), nonce);
  const data = Buffer.concat([cipher.update(summary, 'utf8'), cipher.final()]);
  return { type: 'compaction', id: 'cmp_' + randomUUID().replaceAll('-', ''),
    encrypted_content: prefix + Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url') };
}
export function expandContext(input, token) {
  if (!Array.isArray(input)) return input;
  const items = new Map(input.filter(item => item?.id && item.type !== 'item_reference').map(item => [item.id, item]));
  const referenced = new Set(input.filter(item => item?.type === 'item_reference' && items.has(item.id)).map(item => item.id));
  const seen = new Set();
  return input.flatMap(item => {
    if (item?.type === 'item_reference' && items.has(item.id)) {
      if (seen.has(item.id)) return [];
      item = items.get(item.id);
    } else if (referenced.has(item?.id) && seen.has(item.id)) return [];
    if (referenced.has(item?.id)) seen.add(item.id);
    if (['compaction', 'compaction_summary'].includes(item?.type) && item.encrypted_content?.startsWith(prefix)) {
      const data = Buffer.from(item.encrypted_content.slice(prefix.length), 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key(token), data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      const summary = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
      return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: summary }] }];
    }
    return [item];
  });
}
export function compactionRejected(status, message) {
  return [400, 404, 422].includes(status) && /invalid_encrypted_content|encrypted.*(?:invalid|decrypt|different|mismatch)|(?:invalid|decrypt|mismatch).*encrypted|compaction.*(?:invalid|unsupported|not supported)|(?:item|reference).*(?:not found|does not exist)/i.test(message || '');
}
export async function readSummary(stream) {
  const decoder = new TextDecoder();
  let buffer = '', text = '', completed, size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > 4 * 1024 * 1024) throw new Error('Compaction response exceeds 4 MiB.');
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const record = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const raw = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!raw || raw === '[DONE]') continue;
      const event = JSON.parse(raw);
      if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('Compaction was not completed.');
      if (event.type === 'response.output_text.delta') text += event.delta || '';
      if (event.type === 'response.completed') {
        if (event.response?.output?.some(item => item.type !== 'message' && item.type !== 'reasoning')) throw new Error('Compaction returned a tool call instead of a summary.');
        completed = event.response;
      }
    }
  }
  if (!completed) throw new Error('Compaction stream ended before completion.');
  const output = (completed.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
  const summary = output || text;
  if (!summary.trim()) throw new Error('Compaction returned no readable summary.');
  return { summary, usage: completed.usage };
}
