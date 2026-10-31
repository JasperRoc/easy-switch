import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotes } from '../desktop/release-notes.js';

test('release notes select the UI language without showing another language or marker', () => {
  const body = '<!-- easy-switch:notes:en -->\n## Improvements\n- English notes\n<!-- easy-switch:notes:zh-CN -->\n## 改进\n- 中文更新说明\n';
  assert.equal(releaseNotes(body, 'en'), '## Improvements\n- English notes');
  assert.equal(releaseNotes(body, 'zh-CN'), '## 改进\n- 中文更新说明');
  assert.equal(releaseNotes('Legacy English notes', 'zh-CN'), '');
  assert.equal(releaseNotes('Legacy English notes', 'en'), 'Legacy English notes');
});
