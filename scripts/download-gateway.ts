import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { createWriteStream } from 'node:fs';
const [version, arch, output] = process.argv.slice(2);

async function main() {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['x64', 'arm64'].includes(arch) || !output) throw new Error('Invalid Linux gateway version or architecture.');
  const name = `fluid-${version}-linux-${arch}`;
  const options = { headers: { 'user-agent': 'fluid-installer', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) };
  const metadata = await fetch(`https://api.github.com/repos/JasperRoc/fluid/releases/tags/v${version}`, options);
  if (!metadata.ok) throw new Error(`Linux gateway release lookup returned HTTP ${metadata.status}.`);
  const { assets } = await metadata.json();
  const asset = assets?.find(item => item.name === name);
  const url = `https://github.com/JasperRoc/fluid/releases/download/v${version}/${name}`;
  if (!asset || asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')
      || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 32 * 1024 * 1024) {
    throw new Error('A verified Linux gateway asset is unavailable.');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok || !response.body) throw new Error(`Linux gateway download returned HTTP ${response.status}.`);
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), async function* (chunks) {
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      if (size > asset.size) throw new Error('Linux gateway exceeds its release size.');
      hash.update(chunk);
      yield chunk;
    }
  }, createWriteStream(output, { flags: 'wx', mode: 0o755 }));
  if (size !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('Linux gateway checksum mismatch.');
}

main().catch(error => {
  if (output) fs.rmSync(output, { force: true });
  console.error(error.message);
  process.exitCode = 1;
});
