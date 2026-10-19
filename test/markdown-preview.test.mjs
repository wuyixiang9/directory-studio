import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const manifest = JSON.parse(await readFile(new URL('../vendor-manifest.json', import.meta.url), 'utf8'));
const vendor = await readFile(new URL('../vendor/markdown-it-' + manifest.markdownIt.version + '/' + manifest.markdownIt.distribution, import.meta.url), 'utf8');
const common = { exports: {} };
new vm.Script(vendor).runInNewContext({ module: common, exports: common.exports });
const source = await readFile(new URL('../markdown-preview.src.js', import.meta.url), 'utf8');
const make = () => {
  const frames = new Map();
  let id = 0;
  const context = vm.createContext({
    URL, Blob, MarkdownIt: common.exports,
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  context.paint = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  new vm.Script(source).runInContext(context);
  return context;
};

test('shared renderer disables HTML and automatic remote resource loads', () => {
  const context = make();
  const renderer = context.createStudioMarkdownRenderer(common.exports, new URL('file:///C:/docs/readme.md'));
  const result = renderer.render('# Heading\n<script>alert(1)</script>\n![remote](https://example.com/tracker.png)\n[bad](javascript:alert(1))\n[web](https://example.com)\n[relative](other.md)');
  assert.match(result.html, /<h1>Heading<\/h1>/);
  assert.doesNotMatch(result.html, /<script|<img|href="javascript:/i);
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /rel="noopener noreferrer"/);
  assert.match(result.html, /href="file:\/\/\/C:\/docs\/other.md"/);
  assert.match(result.html, /target="_blank"/);
  assert.match(result.html, /\[图片：remote · 未加载\]/);
});

test('Mermaid source is separated from safe reading HTML and resets between documents', () => {
  const context = make();
  const renderer = context.createStudioMarkdownRenderer(common.exports, new URL('file:///C:/docs/readme.md'));
  const result = renderer.render('Before\n```mermaid\nflowchart LR\nA-->B\n```\nAfter');
  assert.match(result.html, /data-mermaid-index="0"/);
  assert.match(result.html, /aria-label="Mermaid 图表"/);
  assert.equal(result.blocks.length, 1);
  assert.match(result.blocks[0], /flowchart LR/);
  assert.doesNotMatch(result.html, /A--&gt;B/);
  assert.equal(renderer.render('Plain').blocks.length, 0);
});

test('standalone diagram scheduler yields a painted frame and cancels pending work', () => {
  const context = make();
  let renders = 0;
  context.scheduleStudioDiagramRender(() => { renders++; });
  assert.equal(renders, 0);
  context.paint(); assert.equal(renders, 0);
  context.paint(); assert.equal(renders, 1);
  const cancel = context.scheduleStudioDiagramRender(() => { renders++; });
  context.paint(); cancel(); context.paint(); context.paint();
  assert.equal(renders, 1);
  assert.doesNotMatch(source, /CodeMirror|createTextStudioLibraries/);
});

test('full-file Markdown retains its UTF-8 size guard and renders body before scheduling diagrams', async () => {
  const editor = await readFile(new URL('../text-studio.src.js', import.meta.url), 'utf8');
  const start = editor.indexOf('      function renderPreview()');
  const end = editor.indexOf('      function applyLayout()', start);
  assert.ok(start >= 0 && end > start);
  const context = make();
  let renders = 0;
  let diagramRenders = 0;
  let text = '\u4e2d'.repeat(180000);
  Object.assign(context, {
    clearTimeout() {}, previewTimer: null, previewGeneration: 0, cancelDiagrams() {},
    invalidatePreview() { context.previewGeneration++; context.cancelDiagrams?.(); },
    original: false, activeMode: 'markdown', markdownView: 'split', theme: 'light',
    cm: { getValue: () => text }, preview: { innerHTML: '', textContent: '' },
    markdown: { render() { renders++; return { html: '<p>Readable body</p>', blocks: ['graph LR;A-->B'] }; } },
    mermaidPreview: { render() { diagramRenders++; return Promise.resolve(); } }
  });
  new vm.Script(editor.slice(start, end)).runInContext(context);
  context.renderPreview();
  assert.match(context.preview.textContent, /512 KiB/);
  assert.equal(renders, 0); assert.equal(diagramRenders, 0);
  text = '# Small document'; context.renderPreview();
  assert.equal(context.preview.innerHTML, '<p>Readable body</p>');
  assert.equal(diagramRenders, 0);
  context.paint(); assert.equal(diagramRenders, 0);
  context.paint(); assert.equal(diagramRenders, 1);
  context.renderPreview(); context.original = true;
  context.paint(); context.paint(); assert.equal(diagramRenders, 1);
});
