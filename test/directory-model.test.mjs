import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../directory-model.src.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
new vm.Script(source).runInContext(context);
const plain = value => JSON.parse(JSON.stringify(value));

test('favorites tolerate corrupt storage, normalize URLs, bound records and deduplicate', () => {
  for (const value of [null, {}, 'bad', 3]) assert.deepEqual(plain(context.directoryStudioFavorites(value)), []);
  const records = context.directoryStudioFavorites([
    null, { href: 'https://example.com/' }, { href: 'file:///C:/a.txt' },
    { href: 'file:///c:/%41/?q=1#x', label: '  Work  ' },
    { href: 'file:///C:/A/', label: 'duplicate' },
    { href: 'file:///C:/B/', label: '<script>label only</script>' }
  ]);
  assert.deepEqual(plain(records), [
    { href: 'file:///C:/A/', label: 'Work' },
    { href: 'file:///C:/B/', label: '<script>label only</script>' }
  ]);
  assert.equal(context.directoryStudioFavorites(Array.from({ length: 500 }, (_, i) => ({ href: 'file:///C:/x' + i + '/' }))).length, 200);
  assert.equal(context.directoryStudioNormalizeURL('file:///C:/x/../A/'), 'file:///C:/A/');
});

test('name search and original all/files/folders scope compose without extension or date conditions', () => {
  const state = { query: 'report final', filter: 'files' };
  const entry = { name: 'Final REPORT.md', isDirectory: false, modified: null };
  assert.equal(context.directoryStudioMatches(entry, state), true);
  assert.equal(context.directoryStudioMatches({ ...entry, name: 'report final.js' }, state), true);
  assert.equal(context.directoryStudioMatches({ ...entry, name: 'other.txt' }, state), false);
  assert.equal(context.directoryStudioMatches({ ...entry, isDirectory: true }, state), false);
  assert.equal(context.directoryStudioMatches({ ...entry, isDirectory: true }, { ...state, filter: 'folders' }), true);
  assert.equal(context.directoryStudioMatches({ ...entry, isDirectory: true }, { ...state, filter: 'all' }), true);
});

test('entry context is URL scoped, sanitized and merged without replacing unrelated history state', () => {
  const href = 'file:///C:/work/';
  assert.equal(context.directoryStudioContext({ version: 1, href: 'file:///C:/other/' }, href), null);
  const state = context.directoryStudioContext({ version: 1, href, query: 'abc', sort: 'bad', view: 'bad', page: -1, scroll: -10, body: 'never copy' }, href);
  assert.equal(state.sort, 'name'); assert.equal(state.view, 'list'); assert.equal(state.scroll, 0); assert.equal(state.page, 0);
  assert.equal(Object.hasOwn(state, 'body'), false);
  const merged = context.directoryStudioMergeContext({ unrelated: { value: 7 } }, state);
  assert.equal(merged.unrelated.value, 7); assert.equal(merged.directoryStudioV1, state);
  for (const previous of [1, 'x', [], new Date()]) assert.equal(context.directoryStudioMergeContext(previous, state), null);
  assert.ok(context.directoryStudioMergeContext(null, state));
});

test('local.1 history ignores removed filters and sidebar state while retaining useful return context', () => {
  const href = 'file:///C:/work/';
  const legacy = {
    version: 1, href, query: 'report', filter: 'all', family: 'images', period: 'custom', from: '2099-01-01', to: '2099-01-02',
    selected: 'file:///C:/work/report.md', previewOpen: true, previewWidth: 700,
    sort: 'modified', direction: 'desc', view: 'grid', page: 2, scroll: 300, anchor: 'file:///C:/work/report.md', offset: 25, focus: 'search'
  };
  const state = context.directoryStudioContext(legacy, href);
  for (const key of ['family', 'period', 'from', 'to', 'selected', 'previewOpen', 'previewWidth']) assert.equal(Object.hasOwn(state, key), false);
  assert.equal(state.query, 'report'); assert.equal(state.sort, 'modified'); assert.equal(state.direction, 'desc');
  assert.equal(state.view, 'grid'); assert.equal(state.page, 2); assert.equal(state.scroll, 300);
  assert.equal(state.anchor, legacy.anchor); assert.equal(state.offset, 25); assert.equal(state.focus, 'search');
  assert.equal(context.directoryStudioMatches({ name: 'report.md', isDirectory: false, modified: null }, state), true);
  const previous = { unrelated: { value: 7 }, directoryStudioV1: legacy };
  const merged = context.directoryStudioMergeContext(previous, state);
  assert.equal(merged.unrelated, previous.unrelated);
  assert.equal(merged.directoryStudioV1, state);
  assert.equal(previous.directoryStudioV1.previewOpen, true);
});
