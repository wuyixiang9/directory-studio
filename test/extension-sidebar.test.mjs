import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/studio.js', import.meta.url), 'utf8');
const start = source.indexOf('// Remember each layout independently;');
const end = source.indexOf('const state = {', start);
assert.ok(start >= 0 && end > start);

function fixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  const nodes = new Map();
  const listeners = new Map();
  const media = { matches: false };
  const document = { activeElement: null, body: { dataset: {} } };
  const workspace = { clientWidth: 1440 };
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const events = new Map();
    const attributes = new Map();
    const element = {
      hidden: false, parentElement: workspace, value: '', captures: new Set(),
      style: { setProperty(key, value) { this[key] = value; } },
      contains(target) { return target === this || target?.parent === this; },
      focus() { document.activeElement = this; },
      setAttribute(key, value) { attributes.set(key, value); },
      getAttribute(key) { return attributes.get(key); },
      addEventListener(type, callback) { events.set(type, callback); },
      emit(type, detail = {}) {
        const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 220,
          preventDefault() { this.defaultPrevented = true; }, ...detail };
        events.get(type)?.(event);
        return event;
      },
      setPointerCapture(id) { this.captures.add(id); },
      hasPointerCapture(id) { return this.captures.has(id); },
      releasePointerCapture(id) { this.captures.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
    };
    nodes.set(id, element);
    return element;
  }
  let observer;
  const window = { innerWidth: 1440, matchMedia: () => media,
    addEventListener(type, callback) { listeners.set(type, callback); } };
  const context = vm.createContext({ $, document, window,
    preferences: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: (key, value) => values.set(key, value) },
    menu: { close() {} },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} }
  });
  function $(id) { return node(id); }
  vm.runInContext(source.slice(start, end) + '\nsetupSidebar(); applySidebar();', context);
  return { node, context, values, media, document, window, workspace,
    emitWindow: type => listeners.get(type)?.(), observe: () => observer() };
}

const width = f => Number(f.node('sidebar-resize').getAttribute('aria-valuenow'));

test('sidebar sections default expanded and persist independently without touching content', () => {
  const f = fixture();
  for (const id of ['open-heading', 'favorites-heading', 'recent-heading'])
    assert.equal(f.node(id).getAttribute('aria-expanded'), 'true');
  const search = f.node('open-search');
  search.parent = f.node('open-content');
  search.value = 'draft.md';
  search.focus();
  f.node('open-heading').emit('click');
  assert.equal(f.node('open-content').hidden, true);
  assert.equal(f.document.activeElement, f.node('open-heading'));
  assert.equal(f.node('favorites').hidden, false);
  assert.equal(f.node('recent-files').hidden, false);
  assert.equal(search.value, 'draft.md');
  const restored = fixture(Object.fromEntries(f.values));
  assert.equal(restored.node('open-content').hidden, true);
  assert.equal(restored.node('favorites').hidden, false);
  f.node('open-heading').emit('click');
  assert.equal(search.value, 'draft.md');
  assert.equal(f.node('open-content').hidden, false);
});

test('pointer resizing is live, bounded, committed only on release and restored from preferences', () => {
  const f = fixture();
  const handle = f.node('sidebar-resize');
  handle.emit('pointerdown');
  handle.emit('pointermove', { clientX: 350 });
  assert.equal(width(f), 350);
  assert.equal(f.values.has('extension.sidebarWidth'), false);
  handle.emit('pointerup');
  assert.equal(f.values.get('extension.sidebarWidth'), 350);
  assert.equal(handle.captures.size, 0);
  assert.equal(f.document.body.dataset.sidebarResizing, undefined);
  assert.equal(width(fixture(Object.fromEntries(f.values))), 350);
  handle.emit('keydown', { key: 'End' });
  assert.equal(width(f), 480);
  handle.emit('keydown', { key: 'Home' });
  assert.equal(width(f), 170);
  handle.emit('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(width(f), 210);
  f.workspace.clientWidth = f.window.innerWidth = 701;
  f.emitWindow('resize');
  handle.emit('keydown', { key: 'End' });
  assert.equal(width(f), 375);
});

test('cancel, capture loss, Escape, blur, pagehide and fullscreen clean drag state without saving', () => {
  for (const reason of ['pointercancel', 'lostpointercapture', 'Escape', 'blur', 'pagehide', 'fullscreen']) {
    const f = fixture({ 'extension.sidebarWidth': 280 });
    const handle = f.node('sidebar-resize');
    handle.emit('pointerdown');
    handle.emit('pointermove', { clientX: 420 });
    assert.equal(width(f), 480);
    if (reason === 'Escape') handle.emit('keydown', { key: 'Escape' });
    else if (reason === 'fullscreen') { f.document.body.dataset.previewFullscreen = 'true'; f.observe(); }
    else if (reason === 'blur' || reason === 'pagehide') f.emitWindow(reason);
    else handle.emit(reason);
    assert.equal(width(f), 280, reason);
    assert.equal(f.values.get('extension.sidebarWidth'), 280, reason);
    assert.equal(handle.captures.size, 0, reason);
    assert.equal(f.document.body.dataset.sidebarResizing, undefined, reason);
  }
});

test('responsive bounds never overwrite desired width and narrow collapse has an independent choice', () => {
  const f = fixture({ 'extension.sidebarWidth': 470, 'extension.sidebarCollapsed': false });
  f.workspace.clientWidth = f.window.innerWidth = 720;
  f.emitWindow('resize');
  assert.equal(width(f), 394);
  assert.equal(f.values.get('extension.sidebarWidth'), 470);
  f.media.matches = true;
  f.window.innerWidth = f.workspace.clientWidth = 320;
  f.context.applySidebar();
  assert.equal(f.node('sidebar').hidden, true);
  assert.equal(f.node('sidebar-resize').hidden, true);
  f.values.set('extension.sidebarNarrowCollapsed', false);
  f.context.applySidebar();
  assert.equal(f.node('sidebar').hidden, false);
  assert.equal(f.node('sidebar-resize').tabIndex, -1);
  f.media.matches = false;
  f.window.innerWidth = f.workspace.clientWidth = 1440;
  f.context.applySidebar();
  assert.equal(width(f), 470);
  assert.equal(f.node('sidebar-resize').tabIndex, 0);
});

test('invalid stored widths fall back to the existing desktop width', () => {
  for (const value of ['400', {}, null, false]) assert.equal(width(fixture({ 'extension.sidebarWidth': value })), 220);
});
