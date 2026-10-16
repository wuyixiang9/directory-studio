import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../mermaid-studio.src.js', import.meta.url), 'utf8');
const editor = await readFile(new URL('../text-studio.src.js', import.meta.url), 'utf8');
const context = vm.createContext({ TextEncoder, getTextStudioMermaidBundle: () => 'const marker = "</script>";' });
new vm.Script(source, { filename: 'mermaid-studio.src.js' }).runInContext(context);

test('basic Mermaid families pass and configuration or excessive source fails closed', () => {
  for (const code of ['flowchart LR\nA-->B', 'graph TD; A-->B', 'sequenceDiagram\nA->>B: Hello', 'classDiagram\nclass Cat', 'stateDiagram-v2\n[*]-->A', 'erDiagram\nA ||--o{ B : has', 'gantt\nsection A\nTask :2026-01-01, 1d', 'pie\n"A":1', 'gitGraph\ncommit']) assert.doesNotThrow(() => context.validateMermaidSource(code));
  for (const code of ['%%{init: {"securityLevel":"loose"}}%%\ngraph LR;A-->B', '---\nconfig:\n  theme: dark\n---\ngraph LR;A-->B', 'architecture-beta\nservice A', 'flowchart LR\n' + 'a'.repeat(31 * 1024)]) assert.throws(() => context.validateMermaidSource(code));
  assert.throws(() => context.validateMermaidSource('flowchart LR\n' + '中'.repeat(11000)), /30 KiB/);
});

test('sandbox srcdoc embeds only inline code and denies every resource channel', () => {
  const doc = context.createMermaidSandboxDocument('fixed-test-nonce');
  for (const directive of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src 'none'", "connect-src 'none'", "font-src 'none'", "media-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(doc.includes(directive), directive);
  assert.ok(doc.includes('<\\/script>'));
  assert.doesNotMatch(doc, /unsafe-eval|<script\s+src=/);
  assert.match(source, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(source, /allow-same-origin|allow-popups|allow-forms/);
  assert.ok(source.includes('event.source !== frame.contentWindow'));
  assert.ok(source.includes('event.source !== parent'));
  assert.ok(source.includes('data.nonce !== nonce'));
  assert.ok(source.includes('message.nonce !== config.nonce'));
  assert.ok(source.includes('data.id === request.id'));
});

test('output sanitation and asynchronous lifecycle remain explicit defense layers', () => {
  const sanitizer = source.slice(source.indexOf('function sanitizeMermaidSVG'), source.indexOf('function createMermaidPreviewController'));
  const tags = sanitizer.match(/const tags = new Set\(\[([^\]]+)\]\)/)[1];
  assert.doesNotMatch(tags, /'script'|'foreignobject'|'iframe'|'object'|'embed'|'image'|'audio'|'video'|'animate'|'set'/);
  assert.ok(sanitizer.includes("name.startsWith('on')"));
  assert.ok(sanitizer.includes("node.localName.toLowerCase() === 'a'"));
  assert.ok(sanitizer.includes('new CSSStyleSheet()'));
  assert.ok(sanitizer.includes('resources.has(property)'));
  assert.ok(sanitizer.includes('CSSRule.STYLE_RULE'));
  assert.ok(sanitizer.includes('node.removeAttributeNode(attribute)'));
  assert.ok(source.includes("type: 'image/svg+xml'"));
  assert.ok(source.includes("document.createElement('img')"));
  assert.ok(source.includes('URL.revokeObjectURL'));
  assert.ok(source.includes('current === generation'));
  assert.ok(source.includes('current !== ticket'));
  assert.ok(source.includes('renderer.reset()'));
  assert.ok(editor.includes('mermaidPreview.invalidate()'));
  assert.ok(editor.includes('mermaidPreview.dispose()'));
  assert.ok(source.includes("securityLevel: 'strict'"));
  assert.ok(source.includes('htmlLabels: false'));
  assert.ok(source.includes('maxEdges: 200'));
  assert.doesNotMatch(source, /bindFunctions\s*\??\.?\s*\(/);
});

test('pinned browser distribution has no dynamic imports or dynamic code compilation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../vendor-manifest.json', import.meta.url), 'utf8'));
  const bundle = await readFile(new URL('../vendor/mermaid-' + manifest.mermaid.version + '/' + manifest.mermaid.distribution, import.meta.url), 'utf8');
  assert.equal(Buffer.byteLength(bundle), manifest.mermaid.distributionBytes);
  assert.match(bundle, /@license/);
  assert.doesNotMatch(bundle, /\bimport\s*\(|new Function|\beval\s*\(/);
});
