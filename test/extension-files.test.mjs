import test from 'node:test';
import assert from 'node:assert/strict';
import { persistDocument, readLocal } from '../extension/files.js';

test('first save requests write permission before slow reads or confirmation can consume activation', async () => {
  const bytes = new TextEncoder().encode('original');
  const events = [];
  let output;
  const handle = {
    name: 'notes.txt',
    queryPermission: async () => 'prompt',
    requestPermission: async () => { events.push('permission'); return 'granted'; },
    getFile: async () => { events.push('read'); return { size: bytes.length, arrayBuffer: async () => bytes.buffer }; },
    createWritable: async () => ({ write: async value => { output = value; }, close: async () => events.push('close') })
  };
  globalThis.showOpenFilePicker = async () => [handle];
  globalThis.confirm = () => { events.push('confirm'); return true; };
  const document = { bytes, bom: false, newline: '\n' };
  try {
    await persistDocument('file:///D:/notes.txt', document, 'saved');
    assert.deepEqual(events, ['permission', 'read', 'confirm', 'read', 'close']);
    assert.equal(new TextDecoder().decode(output), 'saved');
    assert.equal(document.handle, handle);
  } finally { delete globalThis.showOpenFilePicker; delete globalThis.confirm; }
});

test('MDC local reads preserve frontmatter and body as UTF-8 text', async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const text = '---\nalwaysApply: true\n---\n\n# Rules\n';
  globalThis.chrome = { extension: { isAllowedFileSchemeAccess: async () => true } };
  globalThis.fetch = async () => new Response(text);
  try {
    const result = await readLocal('file:///D:/rules.MDC');
    assert.equal(result.kind, 'text');
    assert.equal(result.text, text);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
