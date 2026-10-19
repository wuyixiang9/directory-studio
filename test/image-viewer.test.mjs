import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate as settleAsync } from 'node:timers/promises';

const source = await readFile(new URL('../image-viewer.src.js', import.meta.url), 'utf8');
const directory = await readFile(new URL('../directory-studio.src.js', import.meta.url), 'utf8');
const item = (index, extension = 'png') => ({ name: `image-${index}.${extension}`, href: `file:///C:/images/image-${index}.${extension}`, isDirectory: false });
function fixture(options = {}) {
  const created = [], timers = new Map(), intersections = [], resizeObservers = [], requests = [], focus = [], writes = [];
  let timer = 0, root;
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map();
      this.className = ''; this.style = {}; this.clientWidth = 800; this.clientHeight = 600;
      this.naturalWidth = 1600; this.naturalHeight = 1200; this.open = false; this.capture = null; this.hidden = false;
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of [...nodes].reverse()) { node.parent = this; this.children.unshift(node); } }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); if (key === 'src') this._src = ''; }
    set src(value) { this._src = value; requests.push({ node: this, href: value }); }
    get src() { return this._src || ''; }
    matches(selector) { return selector.split(',').includes(this.tagName.toLowerCase()); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type, extra = {}) {
      const event = { key: '', button: 0, pointerId: 1, clientX: 0, clientY: 0, deltaY: -1,
        composedPath: () => [this], preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
      for (const callback of [...this.listeners.get(type) || []]) callback(event);
      return event;
    }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    focus() { root.activeElement = this; }
    scrollIntoView() {}
    getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
    hasPointerCapture(id) { return this.capture === id; }
    setPointerCapture(id) { this.capture = id; }
    releasePointerCapture() { this.capture = null; }
    getContext() { return { drawImage() { if (options.canvasError) throw new Error('Tainted canvas'); } }; }
    toBlob(callback) { if (options.encode) options.encode(callback); else callback({ type: 'image/png' }); }
  }
  root = new Node('root');
  const window = new Node('window');
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); this.disconnected = false; intersections.push(this); }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.disconnected = true; this.nodes.clear(); }
    visible() { this.callback([...this.nodes].map(target => ({ target, isIntersecting: true }))); }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; resizeObservers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({ URL, console, window,
    document: { documentElement: { clientWidth: 800, clientHeight: 600 }, createElement(tag) { const node = new Node(tag); created.push(node); return node; } },
    IntersectionObserver, ResizeObserver,
    navigator: { clipboard: { async write(value) { writes.push(value); }, async writeText(value) { writes.push(value); } } },
    ClipboardItem: class { constructor(value) { this.value = value; } },
    setTimeout(callback) { timers.set(++timer, callback); return timer; }, clearTimeout(id) { timers.delete(id); }
  });
  new vm.Script(source).runInContext(context);
  const viewer = context.directoryStudioCreateImageViewer({ root, restoreFocus: href => focus.push(href) });
  const find = className => {
    function visit(node) { if (node.className === className) return node; for (const child of node.children) { const found = visit(child); if (found) return found; } }
    return visit(root);
  };
  const button = label => created.findLast(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === label);
  return { context, viewer, root, created, timers, intersections, resizeObservers, requests, focus, writes, window, find, button,
    loaded() { const image = find('iv-image'); image.onload(); return image; },
    flushTimers() { for (const callback of [...timers.values()]) callback(); }
  };
}

test('image recognition is case-insensitive, excludes directories and leaves unsupported formats native', () => {
  const { context: c } = fixture();
  for (const extension of ['JPG', 'JPEG', 'png', 'GIF', 'webp', 'avif', 'BMP', 'ico', 'svg']) assert.equal(c.directoryStudioIsImage(item(1, extension)), true);
  for (const extension of ['heic', 'tiff', 'pdf', 'png.exe']) assert.equal(c.directoryStudioIsImage(item(1, extension)), false);
  assert.equal(c.directoryStudioIsImage({ ...item(1), isDirectory: true }), false);
  assert.equal(c.directoryStudioImagePath('file:///C:/some%20folder/a.png'), 'C:\\some folder\\a.png');
  assert.equal(c.directoryStudioImagePath('file://server/share/a.png'), '\\\\server\\share\\a.png');
});

test('sequence preserves full upstream sort/filter order beyond pagination, and window clips without wrapping', () => {
  const { context: c } = fixture();
  const entries = Array.from({ length: 205 }, (_, i) => item(204 - i)); entries.splice(4, 0, item('text', 'txt'));
  const sequence = c.directoryStudioImageSequence(entries);
  assert.equal(sequence.length, 205); assert.equal(sequence[0].name, 'image-204.png'); assert.equal(sequence[204].name, 'image-0.png');
  assert.deepEqual({ ...c.directoryStudioImageWindow(205, 100) }, { start: 90, end: 111 });
  assert.deepEqual({ ...c.directoryStudioImageWindow(205, 0) }, { start: 0, end: 11 });
  assert.deepEqual({ ...c.directoryStudioImageWindow(205, 204) }, { start: 194, end: 205 });
  entries[0].name = 'changed'; assert.equal(sequence[0].name, 'image-204.png');
});

test('fit swaps axes for quarter turns, avoids upscaling and handles missing dimensions', () => {
  const { context: c } = fixture();
  assert.equal(c.directoryStudioImageFit(1600, 800, 800, 600, 0), 0.5);
  assert.equal(c.directoryStudioImageFit(1600, 800, 800, 600, 90), 0.375);
  assert.equal(c.directoryStudioImageFit(1600, 800, 800, 600, 270), 0.375);
  assert.equal(c.directoryStudioImageFit(10, 20, 800, 600, 0), 1);
  assert.equal(c.directoryStudioImageFit(0, 0, 800, 600, 0), 1);
});

test('native modified/middle/context navigation is never intercepted', () => {
  const { context: c } = fixture();
  assert.equal(c.directoryStudioImageClick({ button: 0 }), true);
  for (const event of [{ button: 1 }, { button: 2 }, { button: 0, defaultPrevented: true }, ...['ctrlKey', 'metaKey', 'altKey', 'shiftKey'].map(key => ({ button: 0, [key]: true }))]) assert.equal(c.directoryStudioImageClick(event), false);
  const start = directory.indexOf("        entry.addEventListener('click', event => {");
  const end = directory.indexOf("        entry.addEventListener('auxclick'", start);
  const click = directory.slice(start, end);
  let opened = 0, persisted = 0, handler;
  const context = vm.createContext({
    entry: { addEventListener(type, value) { handler = value; } }, item: item(1), imageSequence: [item(1)],
    persistContext() { persisted++; }, directoryStudioIsImage: c.directoryStudioIsImage, directoryStudioImageClick: c.directoryStudioImageClick,
    imageViewer: { open() { opened++; return true; } }, favoritesMenu: { close() {} }
  });
  new vm.Script(click).runInContext(context);
  for (const event of [{ button: 1 }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true }]) handler({ ...event, preventDefault() { throw new Error('native navigation intercepted'); } });
  let prevented = false; handler({ button: 0, preventDefault() { prevented = true; } });
  assert.equal(opened, 1); assert.equal(persisted, 4); assert.equal(prevented, true);
});

test('controller is lazy; modal bounds, rotation memory, keyboard and frozen navigation work', () => {
  const f = fixture(); assert.equal(f.created.length, 0); assert.equal(f.requests.length, 0);
  const entries = Array.from({ length: 205 }, (_, i) => item(i));
  f.viewer.open(entries, entries[0].href);
  assert.equal(f.button('上一张').disabled, true); assert.equal(f.find('iv-sidebar').children.length, 11);
  entries.reverse(); f.loaded();
  f.button('向右旋转').emit('click'); assert.match(f.find('iv-image').style.transform, /rotate\(90deg\)/);
  f.button('下一张').emit('click'); f.loaded(); assert.equal(f.find('iv-title').textContent, 'image-1.png');
  f.button('上一张').emit('click'); f.loaded(); assert.match(f.find('iv-image').style.transform, /rotate\(90deg\)/);
  f.find('image-viewer').emit('keydown', { key: 'ArrowRight', ctrlKey: true }); assert.equal(f.find('iv-title').textContent, 'image-0.png');
  f.find('image-viewer').emit('keydown', { key: 'ArrowRight' }); f.loaded();
  f.find('image-viewer').emit('keydown', { key: 'R', shiftKey: true }); assert.match(f.find('iv-image').style.transform, /rotate\(270deg\)/);
  f.find('image-viewer').emit('keydown', { key: 'Escape' }); assert.equal(f.viewer.isOpen, false); assert.equal(f.focus[0], item(1).href);
  f.viewer.open([item(1)], item(1).href); assert.equal(f.button('下一张').disabled, true);
  f.viewer.dispose(); assert.equal(f.viewer.open([item(1)], item(1).href), false);
});

test('thumbnails are visible-only and limited to two requests in flight, then fully cancelled', () => {
  const f = fixture(); const entries = Array.from({ length: 30 }, (_, i) => item(i));
  f.viewer.open(entries, entries[15].href);
  assert.equal(f.requests.length, 1, 'only main image before visibility callbacks');
  const observer = f.intersections[0]; observer.visible();
  assert.equal(f.requests.length, 3); assert.equal(f.find('iv-sidebar').children.length, 21);
  f.requests[1].node.onload(); assert.equal(f.requests.length, 4);
  f.viewer.close(); assert.equal(observer.disconnected, true); assert.equal(f.timers.size, 0);
  for (const request of f.requests) { assert.equal(request.node.src, ''); assert.equal(request.node.onload, null); assert.equal(request.node.onerror, null); }
  assert.equal(f.root.children.length, 0); assert.equal(f.window.listeners.get('resize').size, 0);
  assert.ok(f.resizeObservers.every(observer => observer.disconnected));
});

test('stale image events cannot alter current load; error keeps navigation usable; pointer capture is released', () => {
  const f = fixture(); f.viewer.open([item(0), item(1)], item(0).href);
  const old = f.find('iv-image'), stale = old.onload;
  f.button('下一张').emit('click'); stale(); assert.equal(f.find('iv-image').hidden, true);
  f.find('iv-image').onerror(); assert.match(f.find('iv-status').textContent, /无法显示/);
  assert.equal(f.button('上一张').disabled, false);
  f.button('上一张').emit('click'); f.loaded(); f.button('100%').emit('click');
  const stage = f.find('iv-stage'); stage.emit('pointerdown', { clientX: 10, clientY: 10 });
  assert.equal(stage.capture, 1); stage.emit('pointermove', { clientX: 50, clientY: 60 });
  assert.match(f.find('iv-image').style.transform, /translate\(40px,50px\)/);
  f.button('下一张').emit('click'); assert.equal(stage.capture, null);
  stale(); f.viewer.close(); stale(); assert.equal(f.root.children.length, 0); assert.equal(f.timers.size, 0);
});

test('text copy and image copy report actual success, while canvas failure never copies fallback text', async () => {
  const f = fixture(); f.viewer.open([item(0)], item(0).href); f.loaded();
  f.button('复制文件名').emit('click'); await settleAsync();
  assert.equal(f.writes[0], 'image-0.png'); assert.equal(f.find('iv-status').textContent, '已复制文件名。');
  f.button('复制图片（原图，未旋转）').emit('click'); await settleAsync();
  assert.equal(f.writes.length, 2); assert.equal(f.find('iv-status').textContent, '已复制图片（原图，未旋转）。');
  const g = fixture({ canvasError: true }); g.viewer.open([item(0)], item(0).href); g.loaded();
  g.button('复制图片（原图，未旋转）').emit('click'); await settleAsync();
  assert.equal(g.writes.length, 0); assert.match(g.find('iv-status').textContent, /复制失败：Tainted canvas/);
});

test('pending canvas encoding is invalidated by navigation or close, and oversized image copy is rejected', async () => {
  let encoded;
  const f = fixture({ encode(callback) { encoded = callback; } }); f.viewer.open([item(0), item(1)], item(0).href); f.loaded();
  f.button('复制图片（原图，未旋转）').emit('click'); f.button('下一张').emit('click'); encoded({});
  await settleAsync(); assert.equal(f.writes.length, 0); assert.equal(f.find('iv-status').textContent, '正在加载图片…');
  const image = f.loaded(); image.naturalWidth = 20000;
  f.button('复制图片（原图，未旋转）').emit('click'); await settleAsync();
  assert.match(f.find('iv-status').textContent, /超出复制上限/); assert.equal(f.writes.length, 0);
  image.naturalWidth = 100; f.button('复制图片（原图，未旋转）').emit('click'); f.viewer.close(); encoded({});
  await settleAsync(); assert.equal(f.writes.length, 0);
});

test('timeout is terminal for a load identity, and text editing / modified wheel remain native', () => {
  const f = fixture(); f.viewer.open([item(0)], item(0).href);
  const image = f.find('iv-image'), late = image.onload;
  f.flushTimers(); late();
  assert.equal(image.hidden, true); assert.equal(image.src, ''); assert.match(f.find('iv-status').textContent, /无法显示/);
  f.viewer.close();
  f.viewer.open([item(0), item(1)], item(0).href); f.loaded();
  const dialog = f.find('image-viewer');
  const editable = dialog.emit('keydown', { key: 'ArrowRight', composedPath: () => [{ matches: () => true }] });
  assert.equal(editable.defaultPrevented, undefined); assert.equal(f.find('iv-title').textContent, 'image-0.png');
  const wheel = f.find('iv-stage').emit('wheel', { ctrlKey: true });
  assert.equal(wheel.defaultPrevented, undefined);
  f.viewer.dispose();
});

test('offscreen queued thumbnails do not start after earlier requests finish', () => {
  const f = fixture(); f.viewer.open(Array.from({ length: 30 }, (_, i) => item(i)), item(15).href);
  const observer = f.intersections[0]; observer.visible();
  assert.equal(f.requests.length, 3);
  observer.callback([...observer.nodes].map(target => ({ target, isIntersecting: false })));
  f.requests[1].node.onload(); f.requests[2].node.onload();
  assert.equal(f.requests.length, 3);
  f.viewer.dispose();
});

test('focus restoration only changes page when needed and never scrolls the same page', () => {
  const entries = Array.from({ length: 321 }, (_, i) => item(i));
  let renders = 0, scrolls = 0, focused = null;
  const state = { page: 0, original: false };
  const context = vm.createContext({
    state, visibleEntries: entries, host: { isConnected: true },
    list: { querySelectorAll() {
      return entries.slice(state.page * 160, (state.page + 1) * 160).map(entry => ({
        dataset: { entry: entry.href }, focus(options) { assert.equal(options.preventScroll, true); focused = entry.href; },
        scrollIntoView() { scrolls++; }
      }));
    } },
    search: { focus() { focused = 'search'; } },
    render() { renders++; }
  });
  const start = directory.indexOf('    function restoreImageFocus(href) {');
  const end = directory.indexOf('    guard.cleanup.push', start);
  new vm.Script(directory.slice(start, end)).runInContext(context);
  context.restoreImageFocus(entries[10].href);
  assert.equal(renders, 0); assert.equal(scrolls, 0); assert.equal(focused, entries[10].href);
  context.restoreImageFocus(entries[310].href);
  assert.equal(state.page, 1); assert.equal(renders, 1); assert.equal(scrolls, 1); assert.equal(focused, entries[310].href);
  context.restoreImageFocus('file:///removed.png'); assert.equal(focused, 'search');
});

test('dialog width is constrained to the available containing block, including the 700px mobile breakpoint', () => {
  const f = fixture(); f.viewer.open([item(0)], item(0).href);
  const css = f.created.find(node => node.tagName === 'STYLE').textContent;
  const rules = [...css.matchAll(/\.image-viewer\{([^}]+)\}/g)].map(match => new Map(
    match[1].split(';').filter(Boolean).map(declaration => declaration.split(':'))
  ));
  assert.equal(rules.length, 2);
  assert.equal(rules[0].get('width'), 'calc(100% - 32px)');
  assert.equal(rules[0].get('max-width'), 'min(1800px,100%)');
  assert.match(css, /@media\(max-width:700px\)\{\.image-viewer\{/);
  assert.equal(rules[1].get('width'), '100%');
  assert.equal(rules[1].get('max-width'), '100%');
  for (const rule of rules) {
    assert.doesNotMatch(rule.get('width'), /vw/);
    assert.doesNotMatch(rule.get('max-width'), /vw/);
  }
  f.viewer.dispose();
});

test('primary controls are centered without visible titles and file actions remain separate', () => {
  const f = fixture(); f.viewer.open([item(0)], item(0).href);
  assert.deepEqual(f.find('image-viewer').children.map(node => node.className),
    ['iv-header', 'iv-body', 'iv-tools', 'iv-status']);
  const tools = f.find('iv-tools'), primary = f.find('iv-tool-primary');
  assert.equal(tools.children[0], primary);
  const groups = [...primary.children, tools.children[1]];
  assert.deepEqual(groups.map(node => node.getAttribute('aria-label')), ['浏览', '缩放', '旋转', '文件']);
  assert.deepEqual(groups.map(node => node.children[0].children.map(control => control.textContent || control.children[0].textContent)),
    [['上一张', '下一张', '缩略图'], ['缩小', '放大', '适应窗口', '100%'], ['向左旋转', '向右旋转'], ['打开原图', '复制']]);
  assert.ok(groups.every(node => node.getAttribute('role') === 'group'));
  assert.equal(f.find('iv-tool-label'), undefined);
  const css = f.created.find(node => node.tagName === 'STYLE').textContent;
  assert.match(css, /\.iv-tools\{[^}]*grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\);/);
  assert.match(css, /\.iv-tool-primary\{grid-column:2;/);
  assert.match(css, /\.iv-tools>\.iv-tool-group\{grid-column:3;justify-self:end;/);
  f.viewer.dispose();
});

test('copy popup hugs its trigger above, aligns its right edge near the viewport edge and respects inset bounds', () => {
  const f = fixture(), position = f.context.directoryStudioImageMenuPosition;
  const bounds = { left: 0, top: 0, right: 800, bottom: 600 }, menu = { width: 220, height: 140 };
  const middle = position({ left: 300, right: 350, top: 500, bottom: 530 }, menu, bounds);
  assert.equal(middle.left, 300); assert.equal(middle.top, 354);
  const right = position({ left: 740, right: 790, top: 500, bottom: 530 }, menu, bounds);
  assert.equal(right.left, 570); assert.equal(right.top, 354);
  const narrow = position({ left: 310, right: 350, top: 650, bottom: 680 }, menu, { left: 0, top: 0, right: 375, bottom: 844 });
  assert.equal(narrow.left, 130); assert.equal(narrow.top, 504);
  const inset = position({ left: 2, right: 50, top: 22, bottom: 52 }, menu, { left: 10, top: 15, right: 390, bottom: 400 });
  assert.equal(inset.left, 18); assert.equal(inset.top, 58);
  f.viewer.dispose();
});

test('copy popup uses live trigger geometry, closes on outside or resize, and Escape returns focus before closing the viewer', () => {
  const f = fixture(); f.viewer.open([item(0)], item(0).href);
  const copy = f.find('iv-copy'), summary = copy.children[0], panel = f.find('iv-copy-panel'), dialog = f.find('image-viewer');
  summary.rect = { left: 500, right: 550, top: 500, bottom: 530, width: 50, height: 30 };
  panel.rect = { width: 220, height: 140 };
  const click = summary.emit('click');
  assert.equal(click.defaultPrevented, true); assert.equal(copy.open, true);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.style.left, '500px'); assert.equal(panel.style.top, '354px');
  dialog.emit('keydown', { key: 'Escape' });
  assert.equal(copy.open, false); assert.equal(f.viewer.isOpen, true); assert.equal(f.root.activeElement, summary);
  summary.emit('click'); dialog.emit('pointerdown', { composedPath: () => [f.find('iv-stage')] });
  assert.equal(copy.open, false);
  summary.emit('click'); f.window.emit('resize'); assert.equal(copy.open, false);
  summary.emit('click'); f.window.emit('scroll'); assert.equal(copy.open, false);
  dialog.emit('keydown', { key: 'Escape' }); assert.equal(f.viewer.isOpen, false);
});
