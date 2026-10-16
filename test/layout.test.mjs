import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../text-studio.src.js', import.meta.url), 'utf8');
const rule = selector => {
  const start = source.indexOf(selector + '{');
  assert.notEqual(start, -1, 'Expected layout selector: ' + selector);
  return source.slice(start + selector.length + 1, source.indexOf('}', start));
};

test('Mermaid surfaces expand with content instead of creating a capped inner scroller', () => {
  const surface = rule('#local-text-studio .lts-mermaid-surface');
  assert.doesNotMatch(surface, /(?:^|;)\s*(?:height|max-height)\s*:/);
  assert.match(surface, /(?:^|;)\s*overflow\s*:\s*visible\s*(?:;|$)/);
});

test('Mermaid images keep automatic height and responsive width', () => {
  const image = rule('#local-text-studio .lts-mermaid-image');
  assert.match(image, /(?:^|;)\s*height\s*:\s*auto\s*(?:;|$)/);
  assert.match(image, /(?:^|;)\s*max-width\s*:\s*100%\s*(?:;|$)/);
});
