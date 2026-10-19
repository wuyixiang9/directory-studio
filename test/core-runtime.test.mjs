import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../core-runtime.src.js', import.meta.url), 'utf8');
const make = overrides => {
  const context = vm.createContext({ URL, Blob, performance: { now: () => 1 }, ...overrides });
  new vm.Script(source).runInContext(context);
  return context;
};

test('directory startup does not read file bodies, obtain resources or execute dependencies', () => {
  let reads = 0;
  const document = { contentType: 'text/html', get body() { throw new Error('unexpected body access'); } };
  const context = make({ document, location: { href: 'file:///C:/work/' }, GM_getResourceText: () => { reads++; throw new Error('unexpected resource access'); } });
  assert.equal(context.startLocalTextStudio(), false);
  assert.equal(reads, 0);
});

test('resource factories are demand-loaded once and Mermaid is not executable through loader', async () => {
  let reads = 0;
  const context = make({ GM_getResourceText: name => { reads++; return 'return { resource: "' + name + '" };'; } });
  assert.equal(reads, 0);
  const [first, second] = await Promise.all([context.directoryStudioLoadResource('markdown'), context.directoryStudioLoadResource('markdown')]);
  assert.equal(first, second); assert.equal(first.resource, 'markdown'); assert.equal(reads, 1);
  await context.directoryStudioLoadResource('markdown'); assert.equal(reads, 1);
  await assert.rejects(context.directoryStudioLoadResource('mermaid'), /Unknown executable/);
  assert.equal(reads, 1);
});

test('failed resource factories fail open and can be retried without stale cache poisoning', async () => {
  let reads = 0;
  const context = make({ GM_getResourceText: () => ++reads === 1 ? 'throw new Error("unavailable")' : 'return { ok: true };' });
  await assert.rejects(context.directoryStudioLoadResource('editor'), /unavailable/);
  assert.equal((await context.directoryStudioLoadResource('editor')).ok, true);
  assert.equal(reads, 2);
});

test('standalone text editor eligibility excludes executable HTML SVG XML and unknown extensions', () => {
  const context = make();
  assert.equal(context.directoryStudioTextEligible(new URL('file:///C:/a.md'), 'text/plain'), true);
  assert.equal(context.directoryStudioTextEligible(new URL('file:///C:/a.json'), 'application/json'), true);
  for (const [file, mime] of [['a.md', 'text/html'], ['a.xml', 'application/xml'], ['a.svg', 'image/svg+xml'], ['a.html', 'text/plain'], ['a.bin', 'text/plain']]) assert.equal(context.directoryStudioTextEligible(new URL('file:///C:/' + file), mime), false);
});

test('native PRE checks preserve browser decoded text and reject active markup structures', () => {
  const context = make();
  const pre = { tagName: 'PRE', children: [], isContentEditable: false, textContent: 'decoded text' };
  const body = { id: '', className: '', isContentEditable: false, children: [pre], childNodes: [pre] };
  assert.equal(context.directoryStudioNativeText({ body }, 'text/plain').pre.textContent, 'decoded text');
  assert.equal(context.directoryStudioNativeText({ body: { ...body, id: 'app' } }, 'text/plain'), null);
  assert.equal(context.directoryStudioNativeText({ body: { ...body, children: [pre, pre] } }, 'text/plain'), null);
  assert.equal(context.directoryStudioNativeText({ body: { ...body, children: [{ ...pre, children: [{}] }] } }, 'text/plain'), null);
  const formatter = { tagName: 'DIV', className: 'json-formatter-container', id: '', childNodes: [], shadowRoot: null, isContentEditable: false };
  assert.ok(context.directoryStudioNativeText({ body: { ...body, children: [pre, formatter] } }, 'application/json'));
  assert.equal(context.directoryStudioNativeText({ body: { ...body, children: [pre, formatter] } }, 'text/plain'), null);
});

test('text limits count UTF-8 bytes and CRLF lines without evaluating file text', () => {
  const context = make();
  assert.equal(context.directoryStudioTextWithinLimit('x'.repeat(2 * 1024 * 1024)), true);
  assert.equal(context.directoryStudioTextWithinLimit('x'.repeat(2 * 1024 * 1024 + 1)), false);
  assert.equal(context.directoryStudioTextWithinLimit('\u4e2d'.repeat(700000)), false);
  assert.equal(context.directoryStudioTextWithinLimit('x\r\n'.repeat(49999)), true);
  assert.equal(context.directoryStudioTextWithinLimit('x\n'.repeat(50000)), false);
});

test('enhanced interactive follows one painted restoration frame and can be canceled before completion', () => {
  const frames = new Map();
  let id = 0;
  const context = make({
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  const paint = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  const events = [];
  context.directoryStudioAfterListPaint(() => events.push('restored'), () => events.push('interactive'));
  assert.deepEqual(events, []);
  paint(); assert.deepEqual(events, ['restored']);
  paint(); assert.deepEqual(events, ['restored', 'interactive']);
  const cancel = context.directoryStudioAfterListPaint(() => events.push('canceled-restore'), () => events.push('canceled-interactive'));
  cancel(); paint(); paint();
  assert.deepEqual(events, ['restored', 'interactive']);
});

test('directory integration records mount separately and restores context before its list endpoint', async () => {
  const directory = await readFile(new URL('../directory-studio.src.js', import.meta.url), 'utf8');
  const start = directory.indexOf('const cancelListReady = directoryStudioAfterListPaint');
  const finish = directory.indexOf('guard.cleanup.push(cancelListReady)', start);
  const lifecycle = directory.slice(start, finish);
  assert.ok(start > directory.indexOf(`performance.mark('directory-studio-mount-complete')`));
  assert.ok(lifecycle.indexOf(`performance.mark('directory-studio-enhanced-interactive')`) > lifecycle.indexOf('restoring = false'));
});
