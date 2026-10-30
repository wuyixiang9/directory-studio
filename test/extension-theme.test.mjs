import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bootstrap = await readFile(new URL('../extension/theme.js', import.meta.url), 'utf8');
const studio = await readFile(new URL('../extension/studio.js', import.meta.url), 'utf8');
const editor = await readFile(new URL('../text-studio.src.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/studio.html', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

function shell(saved, darkOS = false, blocked = false) {
  const storage = new Map(saved === null ? [] : [['directory-studio.theme', saved]]);
  const listeners = {};
  const select = { value: '', addEventListener(type, listener) { listeners[type] = listener; } };
  const forwarded = [];
  const context = vm.createContext({
    document: { documentElement: { dataset: {} } },
    window: {},
    localStorage: {
      getItem(key) { if (blocked) throw Error('Storage blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw Error('Storage blocked'); storage.set(key, value); }
    },
    matchMedia: () => ({ matches: darkOS }),
    $: () => select,
    editor: { setTheme(value) { forwarded.push(value); } }
  });
  vm.runInContext(bootstrap, context);
  vm.runInContext(section(studio, 'const preferences =', 'const studioURL ='), context);
  vm.runInContext(section(studio, "$('theme').value =", "$('capture').addEventListener"), context);
  return { context, storage, select, listeners, forwarded };
}

test('pre-paint restoration preserves every explicit theme regardless of OS preference', () => {
  for (const saved of ['light', 'dark', 'economist', 'vercel']) {
    for (const darkOS of [false, true]) {
      const { context, select } = shell(saved, darkOS);
      assert.equal(context.document.documentElement.dataset.theme, saved);
      assert.equal(context.window.studioPreferences.get('directory-studio.theme', 'light'), saved);
      assert.equal(select.value, saved);
    }
  }
});

test('missing, unknown and unavailable theme storage falls back to OS preference', () => {
  for (const saved of [null, '', 'unknown', '"dark"']) {
    for (const darkOS of [false, true]) {
      const { context, select } = shell(saved, darkOS);
      assert.equal(context.document.documentElement.dataset.theme, darkOS ? 'dark' : 'light');
      assert.equal(select.value, darkOS ? 'dark' : 'light');
    }
  }
  for (const darkOS of [false, true]) {
    assert.equal(shell('economist', darkOS, true).select.value, darkOS ? 'dark' : 'light');
  }
});

test('native selector persists plain-string preferences and forwards themes without remounting', () => {
  assert.match(html, /<select id="theme" aria-label="[^"]+">/);
  for (const theme of ['light', 'dark', 'economist', 'vercel']) {
    assert.match(html, new RegExp('<option value="' + theme + '">'));
  }
  const { context, select, listeners, forwarded, storage } = shell('light');
  assert.equal(listeners.click, undefined);
  for (const theme of ['economist', 'vercel', 'dark', 'light']) {
    select.value = theme;
    listeners.change();
    assert.equal(context.document.documentElement.dataset.theme, theme);
    assert.equal(storage.get('directory-studio.theme'), theme);
    assert.equal(forwarded.at(-1), theme);
    assert.equal(shell(storage.get('directory-studio.theme')).select.value, theme);
  }
});

test('storage failures do not prevent immediate shell and editor theme changes', () => {
  const { context, select, listeners, forwarded } = shell(null, false, true);
  select.value = 'economist';
  assert.doesNotThrow(() => listeners.change());
  assert.equal(context.document.documentElement.dataset.theme, 'economist');
  assert.equal(forwarded.at(-1), 'economist');
});

test('shared editor initialization and public setTheme preserve all themes and normalize unknown values', () => {
  for (const saved of ['light', 'dark', 'economist', 'vercel', 'unknown']) {
    const rootAttributes = {};
    const context = vm.createContext({
      read: () => saved,
      host: { dataset: {} },
      themeButton: { setAttribute() {} },
      root: { setAttribute(name, value) { rootAttributes[name] = value; } },
      nativeNodes: [], documentStyle: {}, original: false,
      renderPreview() {},
      adapter: { ready(api) { context.api = api; } }
    });
    vm.runInContext(section(editor, 'function normalizeLocalTextStudioTheme', 'function startLoadedTextStudio'), context);
    vm.runInContext(section(editor, '      let theme =', '      let wrap ='), context);
    vm.runInContext(section(editor, '      function applyTheme()', '      function updateStatus()'), context);
    vm.runInContext(section(editor, '      if (adapter) adapter.ready({', '    } catch (error)'), context);
    vm.runInContext('applyTheme()', context);
    assert.equal(context.host.dataset.theme, saved === 'unknown' ? 'light' : saved);
    for (const value of ['economist', 'vercel', 'dark', 'light', 'unknown']) {
      context.api.setTheme(value);
      const expected = value === 'unknown' ? 'light' : value;
      assert.equal(context.host.dataset.theme, expected);
      assert.equal(rootAttributes['data-local-text-studio-theme'], expected);
    }
  }
});

test('light palettes retain the supported light diagram protocol for both renderers', () => {
  const requested = [];
  const context = vm.createContext({
    clearTimeout() {}, previewTimer: null, previewGeneration: 0, cancelDiagrams() {},
    renderedText: null, renderedTheme: null,
    previewVisible: () => context.markdownView !== 'edit',
    invalidatePreview() { context.previewGeneration++; context.cancelDiagrams(); context.renderedText = null; },
    original: false, activeMode: 'markdown', markdownView: 'split', theme: 'economist',
    Blob, cm: { getValue: () => '# Document' }, preview: {},
    markdown: { render: () => ({ html: '<h1>Document</h1>', blocks: ['mermaid'], markmapBlocks: ['markmap'] }) },
    scheduleStudioDiagramRender(callback) { callback(); return () => {}; },
    mermaidPreview: { render(blocks, theme) { requested.push(['mermaid', theme]); return Promise.resolve(); } },
    markmapPreview: { render(blocks, theme) { requested.push(['markmap', theme]); return Promise.resolve(); } }
  });
  vm.runInContext(section(editor, '      function renderPreview()', '      function applyLayout()'), context);
  for (const theme of ['economist', 'vercel', 'dark', 'light']) {
    context.theme = theme;
    context.renderPreview();
    assert.equal(context.preview.innerHTML, '<h1>Document</h1>');
    assert.deepEqual(requested.slice(-2), [['mermaid', theme === 'dark' ? 'dark' : 'light'], ['markmap', theme === 'dark' ? 'dark' : 'light']]);
  }
});

test('Vercel inherits every default light syntax color instead of overriding it', () => {
  const base = editor.match(/#local-text-studio\{([^}]+)\}/)?.[1];
  const vercel = editor.match(/#local-text-studio\[data-theme=vercel\]\{([^}]+)\}/)?.[1];
  assert.ok(base && vercel);
  const declarations = (css) => Object.fromEntries([...css.matchAll(/(--[\w-]+):([^;]+)/g)].map(([, key, value]) => [key, value]));
  const lightTokens = declarations(base);
  const vercelTokens = declarations(vercel);
  const resolved = { ...lightTokens, ...vercelTokens };
  for (const name of ['keyword', 'string', 'number', 'comment', 'tag']) {
    const token = '--' + name;
    assert.match(lightTokens[token], /^#[\da-f]{6}$/i);
    assert.equal(Object.hasOwn(vercelTokens, token), false, token + ' must inherit the light palette');
    assert.equal(resolved[token], lightTokens[token]);
  }
  assert.equal(new Set(['keyword', 'string', 'number', 'comment', 'tag'].map((name) => resolved['--' + name])).size, 5);
});
