import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { recentExternalFiles, createRecentExternalRecorder, RECENT_EXTERNAL_FILES_KEY } from '../extension/recent-files.js';
import { prepareStudioLink, studioLinkTarget } from '../extension/navigation.js';
import { pathLabel } from '../extension/model.js';

const studioURL = 'chrome-extension://test/studio.html';
const source = await readFile(new URL('../extension/studio.js', import.meta.url), 'utf8');
const select = (start, end) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
};

function link(href, { original = false, download = false, entry = false } = {}) {
  return {
    href, dataset: {}, title: '', textContent: '',
    get hash() { return new URL(this.href).hash; },
    classList: { contains: (name) => original && name === 'iv-original' },
    hasAttribute: (name) => download && name === 'download',
    closest(selector) { return entry && selector === '#entries' ? {} : null; }
  };
}

test('recent paths are normalized, bounded, deduplicated and untrusted entries are discarded', () => {
  for (const value of [null, {}, 'file:///D:/a.md', 42]) assert.deepEqual(recentExternalFiles(value), []);
  const values = [null, {}, { href: 'file:///D:/forged.md' }, 'https://evil/a.md', 'javascript:alert(1)',
    'file:///D:/', 'file:///D:/a.html', 'file:///D:/a.pdf', 'file:///D:/bad%2fpath.md',
    'file:///D:/bad%xx.md', 'file:///d:/a.md?secret=value#heading', 'D:\\a.md', 'file:///D:/photo.PNG'];
  assert.deepEqual(recentExternalFiles(values), ['file:///D:/a.md', 'file:///D:/photo.PNG']);
  assert.equal(recentExternalFiles(Array.from({ length: 30 }, (_, i) => `file:///D:/${i}.txt`)).length, 15);
});

test('single-writer queue preserves concurrent opens, newest first, and moves duplicates to the front', async () => {
  let stored = [];
  let active = 0;
  let maximum = 0;
  const writes = [];
  const record = createRecentExternalRecorder({
    async get() { active++; maximum = Math.max(maximum, active); await Promise.resolve(); return { recentExternalFiles: stored.slice() }; },
    async set(value) { await Promise.resolve(); stored = value.recentExternalFiles; writes.push(stored.slice()); active--; }
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) => record(`file:///D:/${i}.md`)));
  assert.equal(maximum, 1);
  assert.deepEqual(stored, Array.from({ length: 15 }, (_, i) => `file:///D:/${19 - i}.md`));
  await record('file:///d:/8.md#anchor');
  assert.equal(stored[0], 'file:///D:/8.md');
  assert.equal(stored.length, 15);
  assert.equal(stored.filter((href) => href === 'file:///D:/8.md').length, 1);
  const count = writes.length;
  await record('file:///D:/');
  await record('file:///D:/a.html');
  assert.equal(writes.length, count);
});

test('failed reads and writes settle harmlessly and do not poison subsequent queued records', async () => {
  let stored = ['file:///D:/old.txt'];
  let fail = 'get';
  const record = createRecentExternalRecorder({
    async get() { if (fail === 'get') throw Error('Read denied'); return { recentExternalFiles: stored }; },
    async set(value) { if (fail === 'set') throw Error('Write denied'); stored = value.recentExternalFiles; }
  });
  await assert.doesNotReject(record('file:///D:/failed-read.txt'));
  fail = 'set';
  await assert.doesNotReject(record('file:///D:/failed-write.txt'));
  fail = null;
  await record('file:///D:/next.txt');
  assert.deepEqual(stored, ['file:///D:/next.txt', 'file:///D:/old.txt']);
});

test('supported internal anchors use actual Studio hrefs for native middle-click and context menus', () => {
  for (const href of ['file:///D:/a.md', 'file:///D:/image.png', 'file:///D:/']) {
    const anchor = link(href);
    prepareStudioLink(anchor, studioURL);
    assert.equal(anchor.href, studioURL + '#' + encodeURIComponent(href));
    assert.equal(studioLinkTarget(anchor.href, studioURL), href);
    prepareStudioLink(anchor, studioURL);
    assert.equal(studioLinkTarget(anchor.href, studioURL), href);
  }
  const fragment = link('file:///D:/a.md#title');
  prepareStudioLink(fragment, studioURL);
  assert.equal(fragment.dataset.studioFragment, 'true');
  for (const href of ['https://example.com/a.md', 'file:///D:/a.html', 'file:///D:/a.pdf']) {
    const anchor = link(href);
    prepareStudioLink(anchor, studioURL);
    assert.equal(anchor.href, href);
  }
  for (const options of [{ original: true }, { download: true }]) {
    const anchor = link('file:///D:/a.md', options);
    prepareStudioLink(anchor, studioURL);
    assert.equal(anchor.href, 'file:///D:/a.md');
  }
  for (const url of ['chrome-extension://other/studio.html#file%3A%2F%2F%2FD%3A%2Fa.md',
    studioURL + '#https%3A%2F%2Fevil%2Fa.md', studioURL + '#%xx',
    studioURL + '?x=1#file%3A%2F%2F%2FD%3A%2Fa.md']) {
    assert.equal(studioLinkTarget(url, studioURL), null);
  }
});

test('recent list uses text labels, full path titles and internal routes without changing its data', () => {
  const children = [];
  const nav = { replaceChildren(fragment) { children.splice(0, children.length, ...fragment.children); } };
  const paths = ['file:///D:/%3Cimg%20src%3Dx%3E.md', 'file:///D:/folder/picture.png'];
  const context = vm.createContext({
    recentFiles: paths, studioURL, pathLabel,
    targetHash: (href) => '#' + encodeURIComponent(href),
    $: () => nav,
    document: { createDocumentFragment: () => ({ children: [], append(node) { this.children.push(node); } }) },
    make(tag, className, textContent) { return { tag, className, textContent }; }
  });
  vm.runInContext(select('function renderRecentFiles()', 'async function changeFavorite'), context);
  context.renderRecentFiles();
  assert.equal(children[0].textContent, '<img src=x>.md');
  assert.equal(children[0].innerHTML, undefined);
  assert.equal(children[1].title, 'D:\\folder\\picture.png');
  assert.equal(children[1].href, studioURL + '#' + encodeURIComponent(paths[1]));
  assert.deepEqual(paths, ['file:///D:/%3Cimg%20src%3Dx%3E.md', 'file:///D:/folder/picture.png']);
  context.recentFiles = [];
  context.renderRecentFiles();
  assert.equal(children.length, 1);
  assert.equal(children[0].tag, 'p');
});

test('recent ordinary clicks use dirty-protected navigation, images never reuse the current directory sequence', () => {
  let handler;
  const navigated = [];
  const opened = [];
  let clean = false;
  const context = vm.createContext({
    document: { addEventListener(type, callback) { if (type === 'click') handler = callback; } },
    documentData: null, state: { href: 'file:///D:/current.md', directory: 'file:///D:/current/' },
    linkTarget: (anchor) => studioLinkTarget(anchor.href, studioURL), localURL: (href) => href.startsWith('file:') ? href : null,
    fileKind: (href) => href.endsWith('.png') ? 'image' : 'text',
    navigate(href) { if (clean) navigated.push(href); }, nativeOpen() {}, status() {},
    shared: { directoryStudioImageSequence: (value) => value }, filteredEntries: () => [],
    viewer: { open(...args) { opened.push(args); } },
    chrome: { runtime: { getURL: () => studioURL }, tabs: { create(value) { opened.push(value); } } },
    targetHash: (href) => '#' + encodeURIComponent(href)
  });
  vm.runInContext(select("document.addEventListener('click'", "document.addEventListener('keydown'"), context);
  const image = link(studioURL + '#' + encodeURIComponent('file:///D:/other/picture.png'));
  const event = { target: { closest: () => image }, button: 0, preventDefault() {}, defaultPrevented: false };
  handler(event);
  assert.deepEqual(navigated, []);
  assert.deepEqual(opened, []);
  clean = true;
  handler(event);
  assert.deepEqual(navigated, ['file:///D:/other/picture.png']);
  handler({ ...event, ctrlKey: true });
  assert.equal(opened[0].url, image.href);
  assert.equal(RECENT_EXTERNAL_FILES_KEY, 'recentExternalFiles');
});
