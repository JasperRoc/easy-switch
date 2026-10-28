import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { messages, normalizeLanguage, translate, localizeMessage } from '../desktop/i18n.js';

test('desktop languages cover the same controls and preserve untrusted parameter text', () => {
  assert.deepEqual(Object.keys(messages.en).sort(),Object.keys(messages['zh-CN']).sort());
  assert.equal(normalizeLanguage('zh-Hans-CN'),'zh-CN');
  assert.equal(translate('zh-CN','moveUp',{alias:'<provider>'}), '上移 <provider>');
  const html=fs.readFileSync(new URL('../desktop/index.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)) assert.ok(messages.en[match[1]],match[1]);
  assert.equal(localizeMessage('仅列出服务商目录与 Codex 目录共同识别的模型。','en'),'Showing models recognized by both your provider and Codex.');
});
