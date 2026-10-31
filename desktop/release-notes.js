import { normalizeLanguage } from './i18n.js';

// GitHub release bodies carry independently authored notes for each UI language.
export function releaseNotes(body, language) {
  const sections = [...String(body || '').matchAll(/<!-- easy-switch:notes:(en|zh-CN) -->\s*([\s\S]*?)(?=<!-- easy-switch:notes:|$)/g)];
  const locale = normalizeLanguage(language);
  if (sections.length) return sections.find(match => match[1] === locale)?.[2].trim() || '';
  return locale === 'en' ? String(body || '').trim() : '';
}
