import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../text-studio.src.js', import.meta.url), 'utf8');
const mermaidSource = await readFile(new URL('../mermaid-studio.src.js', import.meta.url), 'utf8');
const context = vm.createContext({ TextEncoder });
new vm.Script(mermaidSource, { filename: 'mermaid-studio.src.js' }).runInContext(context);
const graphA = 'flowchart LR\nA-->B\n';
const graphB = 'sequenceDiagram\nAlice->>Bob: Hello\n';
const graphC = 'flowchart TD\nC-->D\n';
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

test('only explicitly fixed surfaces have a maximum height, without forcing short diagrams to 640px', () => {
  const fixed = rule('#local-text-studio .lts-mermaid-surface[data-height="fixed"]');
  assert.match(fixed, /(?:^|;)\s*max-height\s*:\s*640px\s*(?:;|$)/);
  assert.match(fixed, /(?:^|;)\s*overflow\s*:\s*auto\s*(?:;|$)/);
  assert.doesNotMatch(fixed, /(?:^|;)\s*height\s*:/);
  assert.doesNotMatch(rule('#local-text-studio .lts-mermaid-card'), /(?:^|;)\s*(?:height|max-height)\s*:/);
  assert.doesNotMatch(rule('#local-text-studio .lts-mermaid-source'), /(?:^|;)\s*(?:height|max-height)\s*:/);
});

test('height choices follow exact source rather than raw index across unrelated insertions and reorders', () => {
  const choices = context.createMermaidHeightChoices();
  const first = choices.reconcile([graphA, graphB]);
  assert.equal(choices.isFixed(first[0]), false);
  assert.equal(choices.toggle(first[0]), true);
  const repeated = choices.reconcile([graphA, graphB]);
  assert.equal(repeated[0], first[0]);
  assert.equal(choices.isFixed(repeated[0]), true);
  const reordered = choices.reconcile([graphC, graphB, graphA]);
  assert.equal(reordered[2], first[0]);
  assert.equal(choices.isFixed(reordered[2]), true);
  assert.equal(choices.isFixed(reordered[0]), false);
  assert.equal(choices.isFixed(reordered[1]), false);
});

test('identical diagrams have independent occurrence identities and removed duplicates are pruned', () => {
  const choices = context.createMermaidHeightChoices();
  const first = choices.reconcile([graphA, graphA, graphB]);
  assert.notEqual(first[0], first[1]);
  choices.toggle(first[1]);
  const moved = choices.reconcile([graphB, graphA, graphA]);
  assert.equal(moved[1], first[0]);
  assert.equal(moved[2], first[1]);
  assert.equal(choices.isFixed(moved[1]), false);
  assert.equal(choices.isFixed(moved[2]), true);
  choices.reconcile([graphA]);
  assert.equal(choices.toggle(first[1]), null);
  const restored = choices.reconcile([graphA, graphA]);
  assert.equal(choices.isFixed(restored[1]), false);
});

test('changed definitions and removed diagrams reset to automatic height', () => {
  const choices = context.createMermaidHeightChoices();
  const first = choices.reconcile([graphA]);
  choices.toggle(first[0]);
  const changed = choices.reconcile([graphA.replace('A-->B', 'A-->D')]);
  assert.notEqual(changed[0], first[0]);
  assert.equal(choices.isFixed(changed[0]), false);
  assert.equal(choices.toggle(first[0]), null);
  choices.reconcile([]);
  assert.equal(choices.size, 0);
  assert.equal(choices.isFixed(choices.reconcile([graphA])[0]), false);
});

test('height choice memory is limited to currently allowed valid blocks and clears on disposal', () => {
  const choices = context.createMermaidHeightChoices();
  const sources = Array.from({ length: 14 }, (_, index) => 'flowchart LR\nN' + index + '-->M' + index + '\n');
  const keys = choices.reconcile(sources);
  assert.equal(choices.size, 12);
  assert.equal(keys[12], null);
  assert.equal(keys[13], null);
  choices.toggle(keys[0]);
  choices.reconcile(sources.slice(1, 13));
  assert.equal(choices.size, 12);
  assert.equal(choices.toggle(keys[0]), null);
  const invalid = choices.reconcile(['%%{init:{}}%%\n' + graphA]);
  assert.equal(invalid[0], null);
  assert.equal(choices.size, 0);
  const current = choices.reconcile([graphA]);
  choices.toggle(current[0]);
  choices.clear();
  assert.equal(choices.size, 0);
  assert.equal(choices.toggle(current[0]), null);
  assert.ok(mermaidSource.includes('heightChoices.clear()'));
});

test('height controls remain native, surface-scoped and separate from rendering or persistent storage', () => {
  assert.ok(mermaidSource.includes("heightButton.type = 'button'"));
  assert.ok(mermaidSource.includes("heightButton.setAttribute('aria-controls', surface.id)"));
  assert.ok(mermaidSource.includes("heightButton.setAttribute('aria-pressed', String(fixed))"));
  assert.ok(mermaidSource.includes('surface.scrollTop = 0'));
  const start = mermaidSource.indexOf("heightButton.addEventListener('click', () => {");
  const end = mermaidSource.indexOf('\n        });', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = mermaidSource.slice(start, end);
  for (const guard of ['heightButton.disabled', '!live()', '!card.isConnected', '!preview.contains(card)']) assert.ok(handler.includes(guard));
  assert.ok(handler.includes('heightChoices.toggle(key)'));
  assert.doesNotMatch(handler, /renderer|renderPreview|invalidate|Blob|createObjectURL|revokeObjectURL|GM_|localStorage|cm\./);
});
