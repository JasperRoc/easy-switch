import fs from 'node:fs';
import { EnvHttpProxyAgent, MockAgent } from 'undici';

const original = EnvHttpProxyAgent.prototype.dispatch;
let previous = '';
let mock;
EnvHttpProxyAgent.prototype.dispatch = function (options, handler) {
  let input;
  try { input = fs.readFileSync(process.env.SWITCH_TEST_NETWORK_FIXTURE, 'utf8'); } catch {}
  if (input && input !== previous) {
    void mock?.close();
    mock = new MockAgent();
    for (const [address, value] of Object.entries(JSON.parse(input))) {
      const url = new URL(address);
      mock.get(url.origin).intercept({ path: url.pathname + url.search }).reply(200,
        value.base64 ? Buffer.from(value.base64, 'base64') : value).persist();
    }
    previous = input;
  }
  if (input && Object.hasOwn(JSON.parse(input), String(options.origin) + options.path)) return mock.dispatch(options, handler);
  return original.call(this, options, handler);
};
