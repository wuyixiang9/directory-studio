import test from 'node:test';
import assert from 'node:assert/strict';
let settings = {},
  session = {},
  tab = { id: 2, url: 'file:///D:/notes/a.md' },
  allowed = true,
  updates = [];
const event = () => ({ addListener() {} });
globalThis.chrome = {
  extension: { isAllowedFileSchemeAccess: async () => allowed },
  storage: {
    local: { get: async () => settings },
    session: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (value) => Object.assign(session, value),
      remove: async (key) => delete session[key]
    }
  },
  tabs: {
    get: async () => tab,
    update: async (id, value) => {
      updates.push([id, value]);
    },
    onUpdated: event(),
    onRemoved: event()
  },
  webNavigation: { onBeforeNavigate: event() },
  action: { onClicked: event() },
  runtime: { getURL: (name) => 'chrome-extension://test/' + name, onMessage: event() }
};
const { redirect } = await import('../extension/background.js');
const reset = () => {
  settings = {};
  session = {};
  tab = { id: 2, url: 'file:///D:/notes/a.md' };
  allowed = true;
  updates = [];
};
test('capture only redirects supported current file paths', async () => {
  reset();
  assert.equal(await redirect(2, tab.url), true);
  assert.match(updates[0][1].url, /studio\.html#file/);
  for (const url of ['https://example/a.md', 'file:///D:/a.html', 'file:///D:/a.pdf'])
    assert.equal(await redirect(2, url), false);
  assert.equal(updates.length, 1);
});
test('disabled access, pause and native bypass leave the native navigation intact', async () => {
  reset();
  allowed = false;
  assert.equal(await redirect(2, tab.url), false);
  allowed = true;
  settings.autoCapture = false;
  assert.equal(await redirect(2, tab.url), false);
  settings = {};
  session['native.2'] = { href: tab.url, expires: Date.now() + 10000 };
  assert.equal(await redirect(2, tab.url), false);
  assert.equal(updates.length, 0);
});
test('stale navigation cannot replace a newer destination and pending URL wins', async () => {
  reset();
  tab.url = 'https://example.org/';
  assert.equal(await redirect(2, 'file:///D:/notes/a.md'), false);
  tab.pendingUrl = 'file:///D:/notes/a.md';
  assert.equal(await redirect(2, 'file:///D:/notes/a.md'), true);
  assert.equal(updates.length, 1);
});
test('overlapping navigation notifications update a tab only once', async () => {
  reset();
  const results = await Promise.all([redirect(2, tab.url), redirect(2, tab.url), redirect(2, tab.url)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(updates.length, 1);
});
test('a newer unsupported navigation cancels a waiting file takeover', async () => {
  reset();
  let release;
  const original = chrome.storage.local.get;
  chrome.storage.local.get = () => new Promise((resolve) => (release = () => resolve({})));
  const pending = redirect(2, tab.url);
  assert.equal(await redirect(2, 'https://example.org/'), false);
  release();
  assert.equal(await pending, false);
  assert.equal(updates.length, 0);
  chrome.storage.local.get = original;
});
