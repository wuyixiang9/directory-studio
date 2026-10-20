import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const source = await read('markmap-studio.src.js');
const make = extra => {
  const context = vm.createContext({ TextEncoder, ...extra });
  new vm.Script(source).runInContext(context);
  return context;
};
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Markmap applies UTF-8, source-line, block, node and depth limits', () => {
  const context = make();
  assert.doesNotThrow(() => context.validateMarkmapSource('# Root\n- child'));
  assert.throws(() => context.validateMarkmapSource('\u4e2d'.repeat(11000)), /30 KiB/);
  assert.throws(() => context.validateMarkmapSource('\n'.repeat(600)), /600 lines/);
  assert.throws(() => context.validateMarkmapSource('---\nmarkmap:\n  extraJs: [evil]\n---'), /frontmatter/);
  assert.match(source, /blocks: 6/);
  let root = { content: '', children: [] };
  for (let depth = 0; depth < 21; depth++) root = { content: '', children: [root] };
  const parser = class { parseFromString() { return { body: { textContent: '' }, querySelectorAll: () => [] }; } };
  const normalized = make({ DOMParser: parser });
  assert.throws(() => normalized.normalizeMarkmapTree(root), /300 nodes or depth 20/);
  assert.throws(() => normalized.normalizeMarkmapTree({ content: '', children: Array.from({ length: 300 }, () => ({ content: '' })) }), /300 nodes or depth 20/);
});

test('normalization rebuilds escaped text and drops payload/options before Markmap sees labels', () => {
  const removed = [];
  const context = make({ DOMParser: class {
    parseFromString(html, mime) {
      assert.equal(mime, 'text/html');
      assert.equal(html, 'transformer HTML');
      return { body: { textContent: '<img onerror="evil"> & readable link' }, querySelectorAll(selector) {
        assert.match(selector, /script,style/);
        return [{ remove() { removed.push(true); } }];
      } };
    }
  } });
  const root = context.normalizeMarkmapTree({ content: 'transformer HTML', payload: { fold: 2, extraJs: ['evil'] }, children: [], state: { url: 'https://evil' } });
  assert.equal(root.content, '&lt;img onerror=&quot;evil&quot;&gt; &amp; readable link');
  assert.equal(root.payload, undefined);
  assert.equal(root.state, undefined);
  assert.equal(removed.length, 1);
});

test('sandbox document contains only fixed runtime, never document source, and denies external resources', () => {
  const context = make();
  const document = context.createMarkmapSandboxDocument('fixed-nonce', '/* trusted bundle </script> */');
  assert.match(document, /<\\\/script>/);
  for (const directive of ['default-src', 'img-src', 'connect-src', 'font-src', 'media-src', 'object-src', 'frame-src', 'worker-src', 'base-uri', 'form-action']) assert.ok(document.includes(directive + " 'none'"));
  assert.doesNotMatch(document, /allow-same-origin|https?:\/\/(?!www\.w3\.org)|extraJs|extraCss/);
  assert.match(source, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.match(source, /source, theme \}, '\*'\)/);
  assert.doesNotMatch(source, /getUsedAssets|loadJS\(|loadCSS\(|fetch\(|XMLHttpRequest/);
});

test('runtime binds parent/channel/nonce/request, disables plugins, serializes controls and destroys on disposal', async () => {
  const listeners = new Map();
  const messages = [];
  const parent = { postMessage: message => messages.push(message) };
  const options = [];
  const map = { state: {}, fits: 0, destroys: 0, async setData(root) { if (root) this.state.data = root; }, async fit() { this.fits++; }, destroy() { this.destroys++; } };
  let transforms = 0;
  const context = make({
    parent,
    window: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) },
    document: { documentElement: { dataset: {} } },
    DOMParser: class { parseFromString(text) { return { body: { textContent: text }, querySelectorAll: () => [] }; } },
    markmap: { Transformer: class {
      constructor(plugins) {
        assert.equal(plugins.length, 0);
        this.md = { set(value) { options.push(value); }, renderer: { rules: {} }, utils: { escapeHtml: value => value } };
      }
      transform() { transforms++; return { root: { content: 'root', children: [{ content: 'child', children: [] }] } }; }
    }, Markmap: { create(selector, value) { assert.equal(selector, '#map'); assert.equal(value.initialExpandLevel, 2); return map; } } }
  });
  context.markmapSandboxMain({ channel: 'channel', nonce: 'nonce' });
  assert.equal(messages[0].kind, 'ready');
  const dispatch = (delta, origin = parent) => listeners.get('message')?.({ source: origin, data: { channel: 'channel', nonce: 'nonce', id: 'request', ...delta } });
  dispatch({ kind: 'init', source: '# root' }, {});
  dispatch({ kind: 'init', nonce: 'wrong', source: '# root' });
  await settle(); assert.equal(transforms, 0);
  dispatch({ kind: 'init', source: '# root', theme: 'dark' });
  await settle();
  assert.equal(transforms, 1);
  assert.equal(options[0].html, false);
  assert.equal(options[0].maxNesting, 20);
  assert.equal(messages.at(-1).kind, 'rendered');
  assert.equal(context.document.documentElement.dataset.theme, 'dark');
  dispatch({ kind: 'init', source: '# ignored' });
  dispatch({ kind: 'collapse', id: 'wrong' });
  dispatch({ kind: 'collapse' });
  await settle();
  assert.equal(transforms, 1);
  assert.equal(map.state.data.payload.fold, 1);
  assert.equal(map.state.data.children[0].payload.fold, 1);
  dispatch({ kind: 'expand' });
  await settle();
  assert.equal(map.state.data.payload.fold, 0);
  assert.equal(map.state.data.children[0].payload.fold, 0);
  const fits = map.fits;
  dispatch({ kind: 'fit' }); await settle(); assert.equal(map.fits, fits + 1);
  dispatch({ kind: 'dispose' });
  assert.equal(map.destroys, 1);
  assert.equal(listeners.size, 0);
});

test('runtime reports validation failure without constructing Markmap', async () => {
  const listeners = new Map();
  const messages = [];
  const parent = { postMessage: value => messages.push(value) };
  const context = make({ parent, window: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) } });
  context.markmapSandboxMain({ channel: 'channel', nonce: 'nonce' });
  listeners.get('message')({ source: parent, data: { channel: 'channel', nonce: 'nonce', id: 'request', kind: 'init', source: '---\nextraJs: evil\n---' } });
  await settle();
  assert.equal(messages.at(-1).kind, 'error');
  assert.match(messages.at(-1).error, /frontmatter/);
  assert.equal(listeners.size, 0);
});

test('heavy Markmap resource is separate, hash-pinned and read only after a validated fence', async () => {
  const build = await read('build.mjs');
  const core = await read('core-runtime.src.js');
  assert.match(build, /getTextStudioMarkmapBundle\(\).*getResourceText\("markmap"\)/);
  assert.match(build, /markmap: \{ file: 'markmap\.js'/);
  assert.match(build, /createHash\('sha256'\)/);
  assert.match(core, /\['editor', 'markdown'\]\.includes\(name\)/);
  assert.match(await read('serve-install.mjs'), /'markmap\.js'/);
  assert.match(source, /const start = \(\) => \{[\s\S]*bundle = getTextStudioMarkmapBundle\(\)/);
  const manifest = JSON.parse(await read('vendor-manifest.json'));
  for (const [key, name] of [['markmapLib', 'markmap-lib'], ['markmapView', 'markmap-view'], ['d3', 'd3']]) {
    const item = manifest[key];
    const bytes = Buffer.from(await read('vendor/' + name + '-' + item.version + '/' + item.distribution));
    assert.equal(bytes.length, item.distributionBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.distributionSHA256);
    assert.equal(item.integrityVerifiedDuringVendoring, true);
    assert.match(item.integrity, /^sha512-/);
    assert.match(await read('vendor/' + name + '-' + item.version + '/LICENSE'), /Copyright|copyright/);
  }
  const notices = await read('vendor/markmap-lib-' + manifest.markmapLib.version + '/THIRD-PARTY-NOTICES');
  assert.match(notices, /Permission to use, copy/);
  assert.match(notices, /cheerio/);
  const receipts = JSON.parse(await read('vendor/markmap-lib-' + manifest.markmapLib.version + '/third-party-receipts.json'));
  assert.equal(receipts.upstreamCommit, '205367a24603dc187f67da1658940c6cade20dce');
  assert.ok(receipts.packages.length > 0);
  assert.ok(receipts.packages.every(item => item.integrityVerifiedDuringVendoring && item.integrity.startsWith('sha512-')));
});

test('preview invalidates Markmap alongside Mermaid and resize only fits changed positive widths', async () => {
  const editor = await read('text-studio.src.js');
  assert.match(editor, /mermaidPreview\.invalidate\(\); markmapPreview\.invalidate\(\)/);
  assert.match(editor, /mermaidPreview\.dispose\(\); markmapPreview\.dispose\(\)/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /window\.removeEventListener\('message', onMessage\)/);
  assert.match(source, /next <= 0 \|\| next === width/);
  assert.match(source, /cancelAnimationFrame\(resizeFrame\)/);
  assert.match(source, /card\.isConnected/);
  assert.match(source, /source still|源码仍可查看/);
  assert.match(source, /CPU 硬限制/);
});

function controllerFixture(count = 1) {
  const listeners = new Set();
  const frames = [];
  const observers = [];
  const intersections = [];
  const visibilityListeners = new Set();
  const timers = new Map();
  const paints = new Map();
  let sequence = 0;
  let reads = 0;
  let now = 0;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.isConnected = true; this.handlers = new Map();
      if (tag === 'iframe') {
        this.sent = [];
        this.contentWindow = { postMessage: message => this.sent.push(message) };
        frames.push(this);
      }
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    insertBefore(node, before) { this.children.splice(this.children.indexOf(before), 0, node); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, fn) { this.handlers.set(type, fn); }
    removeEventListener(type) { this.handlers.delete(type); }
    remove() { this.isConnected = false; }
  }
  const cards = Array.from({ length: count }, () => new Element('section'));
  const context = make({
    document: {
      visibilityState: 'visible',
      createElement: tag => new Element(tag),
      addEventListener: (type, fn) => visibilityListeners.add(fn),
      removeEventListener: (type, fn) => visibilityListeners.delete(fn)
    },
    performance: { now: () => now },
    window: { addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) },
    crypto: { randomUUID: () => 'nonce-' + ++sequence },
    getTextStudioMarkmapBundle() { reads++; return '/* trusted offline dependency */'; },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = ++sequence; paints.set(id, fn); return id; },
    cancelAnimationFrame(id) { paints.delete(id); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; intersections.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
    }
  });
  const controller = context.createMarkmapPreviewController({ isConnected: true }, { querySelector: selector => cards[Number(selector.match(/"(\d+)"/)[1])] });
  return { controller, cards, frames, observers, intersections, timers, listeners, visibilityListeners, get reads() { return reads; },
    intersect(index, visible, width = 500, height = 300) {
      intersections[index].callback([{ isIntersecting: visible, intersectionRect: { width, height } }]);
    },
    visibility(state) {
      context.document.visibilityState = state;
      [...visibilityListeners].forEach(listener => listener());
    },
    advance(milliseconds) { now += milliseconds; },
    message(frame, message, overrideSource) {
      for (const listener of listeners) listener({ source: overrideSource || frame.contentWindow, data: message });
    },
    paint() { const pending = [...paints.values()]; paints.clear(); pending.forEach(fn => fn()); }
  };
}

test('controller keeps heavy resources lazy, binds frame messages, controls interactions and releases all frame work', async () => {
  const fixture = controllerFixture();
  await fixture.controller.render([], 'light');
  assert.equal(fixture.reads, 0);
  const text = '# Source marker </script><img src=evil>';
  await fixture.controller.render([text], 'dark');
  assert.equal(fixture.cards[0].dataset.state, 'waiting');
  assert.equal(fixture.reads, 0);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.frames[0].srcdoc, undefined);
  assert.equal(fixture.intersections[0].target, fixture.frames[0]);
  fixture.intersect(0, true);
  assert.equal(fixture.reads, 1);
  const frame = fixture.frames[0];
  const card = fixture.cards[0];
  const buttons = card.children[0].children[1].children;
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)[1];
  const message = { channel: 'directory-studio-markmap-v1', nonce, kind: 'ready', id: null };
  assert.equal(frame.attributes.sandbox, 'allow-scripts');
  assert.doesNotMatch(frame.srcdoc, /Source marker/);
  fixture.message(frame, message, {});
  fixture.message(frame, { ...message, nonce: 'wrong' });
  assert.equal(frame.sent.length, 0);
  fixture.message(frame, message);
  const init = frame.sent[0];
  assert.equal(init.source, text);
  fixture.message(frame, { ...message, kind: 'rendered', id: 'wrong' });
  assert.equal(buttons[0].disabled, true);
  fixture.message(frame, { ...message, kind: 'rendered', id: init.id });
  assert.equal(card.dataset.state, 'ready');
  assert.equal(buttons[0].disabled, false);
  for (const button of buttons) button.handlers.get('click')();
  assert.deepEqual(frame.sent.slice(1).map(value => value.kind), ['fit', 'expand', 'collapse']);
  fixture.observers[0].callback([{ contentRect: { width: 500 } }]); fixture.paint();
  const sent = frame.sent.length;
  fixture.observers[0].callback([{ contentRect: { width: 500 } }]); fixture.paint();
  assert.equal(frame.sent.length, sent);
  fixture.controller.invalidate();
  assert.equal(frame.sent.at(-1).kind, 'dispose');
  assert.equal(frame.isConnected, false);
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.observers[0].disconnected, true);
  assert.equal(fixture.intersections[0].disconnected, true);
  assert.equal(fixture.visibilityListeners.size, 0);
  assert.ok(buttons.every(button => button.disabled && button.handlers.size === 0));
  fixture.controller.dispose();
  await fixture.controller.render([text], 'light');
  assert.equal(fixture.frames.length, 1);
});

test('controller bounds frames, retains source on failures and honestly reports startup timeout', async () => {
  const invalid = controllerFixture();
  await invalid.controller.render(['x'.repeat(31000)], 'light');
  assert.equal(invalid.reads, 0);
  assert.equal(invalid.cards[0].dataset.state, 'error');
  assert.equal(invalid.cards[0].children.at(-1).open, true);
  const fixture = controllerFixture(7);
  await fixture.controller.render(Array(7).fill('# Root'), 'light');
  assert.equal(fixture.frames.length, 6);
  assert.equal(fixture.reads, 0);
  assert.equal(fixture.cards[6].dataset.state, 'error');
  for (let index = 0; index < 6; index++) fixture.intersect(index, true);
  assert.equal(fixture.reads, 1);
  fixture.advance(10000);
  [...fixture.timers.values()].forEach(timeout => timeout.fn());
  assert.equal(fixture.cards[0].dataset.state, 'error');
  assert.match(fixture.cards[0].children[1].textContent, /CPU 硬限制/);
  assert.equal(fixture.cards[0].children.at(-1).open, true);
  assert.equal(fixture.frames[0].isConnected, false);
  fixture.controller.dispose();
});

test('controller starts only for the intersecting iframe in a foreground document and never repeats initialization', async () => {
  const fixture = controllerFixture();
  await fixture.controller.render(['# Root'], 'light');
  const frame = fixture.frames[0];
  assert.equal(fixture.cards[0].dataset.state, 'waiting');
  fixture.intersect(0, true, 500, 0);
  assert.equal(fixture.reads, 0);
  fixture.visibility('hidden');
  fixture.intersect(0, true);
  fixture.advance(60000);
  assert.equal(fixture.reads, 0);
  assert.equal(frame.srcdoc, undefined);
  assert.equal(fixture.timers.size, 0);
  fixture.visibility('visible');
  assert.equal(fixture.cards[0].dataset.state, 'loading');
  assert.equal(fixture.reads, 1);
  assert.equal([...fixture.timers.values()][0].delay, 10000);
  const originalDocument = frame.srcdoc;
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)[1];
  const ready = { channel: 'directory-studio-markmap-v1', nonce, kind: 'ready', id: null };
  const timerId = [...fixture.timers.keys()][0];
  fixture.advance(2500);
  fixture.intersect(0, true);
  assert.equal([...fixture.timers.keys()][0], timerId);
  fixture.visibility('hidden');
  fixture.message(frame, ready);
  assert.equal(frame.sent.length, 0, 'runtime ready while hidden must not initialize');
  assert.equal(fixture.cards[0].dataset.state, 'waiting');
  assert.equal(fixture.timers.size, 0);
  fixture.advance(60000);
  fixture.visibility('visible');
  assert.equal([...fixture.timers.values()][0].delay, 7500);
  assert.equal(frame.sent.filter(message => message.kind === 'init').length, 1);
  fixture.message(frame, ready);
  fixture.intersect(0, true);
  fixture.visibility('visible');
  assert.equal(frame.sent.filter(message => message.kind === 'init').length, 1);
  assert.equal(frame.srcdoc, originalDocument);
  assert.equal(fixture.reads, 1);
  const id = frame.sent[0].id;
  fixture.message(frame, { ...ready, kind: 'rendered', id });
  assert.equal(fixture.cards[0].dataset.state, 'ready');
  assert.equal(fixture.timers.size, 0);
  fixture.intersect(0, false);
  fixture.visibility('hidden');
  fixture.observers[0].callback([{ contentRect: { width: 400 } }]);
  fixture.paint();
  const fits = frame.sent.filter(message => message.kind === 'fit').length;
  fixture.visibility('visible');
  fixture.intersect(0, true);
  fixture.intersect(0, true);
  fixture.paint();
  assert.equal(frame.sent.filter(message => message.kind === 'fit').length, fits + 1);
  assert.equal(fixture.timers.size, 0, 'ready cards never restart the startup budget');
  fixture.controller.invalidate();
  assert.equal(fixture.visibilityListeners.size, 0);
  assert.equal(fixture.intersections[0].disconnected, true);
  assert.equal(fixture.observers[0].disconnected, true);
});

test('controller preserves the cumulative ten-second visible budget across scrolling and tab backgrounding', async () => {
  const fixture = controllerFixture();
  await fixture.controller.render(['# Root'], 'light');
  fixture.intersect(0, true);
  fixture.advance(3500);
  fixture.intersect(0, false);
  assert.equal(fixture.cards[0].dataset.state, 'waiting');
  assert.equal(fixture.timers.size, 0);
  fixture.advance(90000);
  fixture.intersect(0, true);
  assert.equal([...fixture.timers.values()][0].delay, 6500);
  fixture.advance(2000);
  fixture.visibility('hidden');
  assert.equal(fixture.timers.size, 0);
  fixture.advance(90000);
  fixture.visibility('visible');
  assert.equal([...fixture.timers.values()][0].delay, 4500);
  fixture.advance(4500);
  [...fixture.timers.values()][0].fn();
  assert.equal(fixture.cards[0].dataset.state, 'error');
  assert.match(fixture.cards[0].children[1].textContent, /累计可见等待超过 10 秒/);
  assert.equal(fixture.cards[0].children.at(-1).open, true);
  assert.equal(fixture.frames[0].isConnected, false);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.visibilityListeners.size, 0);
  assert.equal(fixture.intersections[0].disconnected, true);
  fixture.controller.dispose();
});
