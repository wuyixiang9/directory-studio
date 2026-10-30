import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
let settings = {},
  session = {},
  tab = { id: 2, windowId: 1, index: 0, url: 'file:///D:/notes/a.md' },
  allowed = true,
  updates = [];
const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });
globalThis.chrome = {
  extension: { isAllowedFileSchemeAccess: async () => allowed },
  storage: {
    local: {
      get: async () => settings,
      set: async (value) => Object.assign(settings, value)
    },
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
    onCreated: event(),
    onUpdated: event(),
    onRemoved: event()
  },
  webNavigation: { onBeforeNavigate: event() },
  action: { onClicked: event() },
  runtime: { getURL: (name) => 'chrome-extension://test/' + name, getContexts: async () => [], onMessage: event() }
};
const { redirect } = await import('../extension/background.js');
const reset = () => {
  settings = {};
  session = {};
  tab = { id: 2, windowId: 1, index: 0, url: 'file:///D:/notes/a.md' };
  allowed = true;
  updates = [];
};
test('capture only redirects supported current file paths', async () => {
  reset();
  assert.equal(await redirect(2, tab.url), true);
  assert.match(updates[0][1].url, /studio\.html#file/);
  assert.deepEqual(settings.recentExternalFiles, [tab.url]);
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
  assert.equal(settings.recentExternalFiles, undefined);
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
test('only successful external text and image takeovers enter recents, not directories or failures', async () => {
  reset();
  tab.url = 'file:///D:/notes/';
  assert.equal(await redirect(2, tab.url), true);
  assert.equal(settings.recentExternalFiles, undefined);
  tab.url = 'file:///D:/notes/picture.png';
  assert.equal(await redirect(2, tab.url), true);
  assert.deepEqual(settings.recentExternalFiles, [tab.url]);
  const update = chrome.tabs.update;
  try {
    chrome.tabs.update = async () => { throw Error('Tab closed'); };
    tab.url = 'file:///D:/notes/failed.md';
    assert.equal(await redirect(2, tab.url), false);
    assert.deepEqual(settings.recentExternalFiles, ['file:///D:/notes/picture.png']);
  } finally {
    chrome.tabs.update = update;
  }
});

test('concurrent successful tabs record independently and a storage failure cannot fail the redirect', async () => {
  reset();
  const getTab = chrome.tabs.get;
  const setStorage = chrome.storage.local.set;
  try {
    chrome.tabs.get = async (id) => ({ id, url: `file:///D:/notes/${id}.md` });
    const results = await Promise.all([redirect(3, 'file:///D:/notes/3.md'), redirect(4, 'file:///D:/notes/4.md')]);
    assert.deepEqual(results, [true, true]);
    assert.deepEqual(settings.recentExternalFiles, ['file:///D:/notes/4.md', 'file:///D:/notes/3.md']);
    chrome.storage.local.set = async () => { throw Error('Storage unavailable'); };
    assert.equal(await redirect(5, 'file:///D:/notes/5.md'), true);
    chrome.storage.local.set = setStorage;
    assert.equal(await redirect(6, 'file:///D:/notes/6.md'), true);
    assert.deepEqual(settings.recentExternalFiles, ['file:///D:/notes/6.md', 'file:///D:/notes/4.md', 'file:///D:/notes/3.md']);
  } finally {
    chrome.tabs.get = getTab;
    chrome.storage.local.set = setStorage;
  }
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

test('MDC navigation and content bridge use the same case-insensitive text route', async () => {
  for (const extension of ['mdc', 'MDC', 'MdC']) {
    reset();
    tab.url = 'file:///D:/notes/rules.' + extension;
    assert.equal(await redirect(2, tab.url), true);
    assert.equal(updates[0][1].url, 'chrome-extension://test/studio.html#' + encodeURIComponent(tab.url));
    const messages = [];
    const window = {};
    window.top = window.self = window;
    vm.runInNewContext(await readFile(new URL('../extension/bridge.js', import.meta.url), 'utf8'), {
      window,
      location: new URL(tab.url),
      chrome: { runtime: { sendMessage: async (message) => messages.push(message) } }
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'capture');
    assert.equal(messages[0].href, tab.url);
  }
});

async function withWorkspace(run) {
  const originals = { get: chrome.tabs.get, remove: chrome.tabs.remove,
    contexts: chrome.runtime.getContexts, message: chrome.runtime.sendMessage };
  const workspace = { id: 9, index: 0, windowId: 1 };
  const context = { contextType: 'TAB', tabId: 9, windowId: 1, frameId: 0,
    documentId: 'workspace-document', documentUrl: 'chrome-extension://test/studio.html' };
  const removed = [];
  chrome.tabs.get = async id => id === 9 ? workspace : tab;
  chrome.tabs.remove = async id => { removed.push(id); };
  chrome.runtime.getContexts = async filter =>
    (!filter.windowIds || filter.windowIds.includes(context.windowId)) &&
    (!filter.tabIds || filter.tabIds.includes(context.tabId)) &&
    (!filter.documentIds || filter.documentIds.includes(context.documentId)) ? [context] : [];
  chrome.runtime.sendMessage = async () => ({ opened: true });
  try { await run({ removed, workspace, context }); } finally {
    chrome.tabs.get = originals.get;
    chrome.tabs.remove = originals.remove;
    chrome.runtime.getContexts = originals.contexts;
    chrome.runtime.sendMessage = originals.message;
  }
}

test('external entry reuses a verified same-window workspace without closing an existing source tab', async () => {
  reset();
  await withWorkspace(async ({ removed }) => {
    assert.equal(await redirect(2, tab.url), true);
    assert.deepEqual(removed, []);
    assert.deepEqual(updates, [[9, { active: true }]]);
    assert.deepEqual(settings.recentExternalFiles, [tab.url]);
  });
});

test('only a newly observed file tab closes, and only after the destination acknowledges opening', async () => {
  reset();
  await withWorkspace(async ({ removed }) => {
    chrome.tabs.onCreated.listeners[0](tab);
    let acknowledge;
    chrome.runtime.sendMessage = () => new Promise(resolve => { acknowledge = resolve; });
    const opening = redirect(2, tab.url);
    while (!acknowledge) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(removed, []);
    acknowledge({ opened: true });
    assert.equal(await opening, true);
    assert.deepEqual(removed, [2]);
  });
});

test('failed handoff preserves the incoming tab and falls back to its own workspace', async () => {
  reset();
  await withWorkspace(async ({ removed }) => {
    chrome.tabs.onCreated.listeners[0](tab);
    chrome.runtime.sendMessage = async () => ({ opened: false });
    assert.equal(await redirect(2, tab.url), true);
    assert.deepEqual(removed, []);
    assert.equal(updates[0][0], 2);
    assert.match(updates[0][1].url, /studio\.html#/);
  });
});

test('a source navigation during handoff is never closed or replaced', async () => {
  reset();
  await withWorkspace(async ({ removed }) => {
    chrome.tabs.onCreated.listeners[0](tab);
    chrome.runtime.sendMessage = async () => {
      tab.url = 'https://example.org/user-navigation';
      return { opened: true };
    };
    assert.equal(await redirect(2, 'file:///D:/notes/a.md'), false);
    assert.deepEqual(removed, []);
    assert.ok(updates.every(([id, value]) => id !== 2 || !value.url));
  });
});

test('a workspace in another window is not a routing target', async () => {
  reset();
  await withWorkspace(async ({ removed, context, workspace }) => {
    context.windowId = workspace.windowId = 8;
    assert.equal(await redirect(2, tab.url), true);
    assert.deepEqual(removed, []);
    assert.equal(updates[0][0], 2);
  });
});

test('ready registration accepts only an exact top-level Studio document identity', () => {
  const listener = chrome.runtime.onMessage.listeners[0];
  const studio = chrome.runtime.getURL('studio.html');
  const sender = { url: studio + '#file', frameId: 0, documentId: 'ready-document', tab: { id: 9 } };
  let response;
  assert.equal(listener({ type: 'studioReady' }, sender, value => { response = value; }), false);
  assert.deepEqual(response, { documentId: 'ready-document' });
  for (const invalid of [
    { ...sender, url: studio + '.evil' },
    { ...sender, url: studio + '?file=1' },
    { ...sender, url: 'https://test/studio.html' },
    { ...sender, frameId: 1 },
    { ...sender, documentId: undefined },
    { ...sender, tab: undefined }
  ]) {
    assert.notEqual(listener({ type: 'studioReady' }, invalid, () => assert.fail('untrusted ready sender')), true);
  }
  for (const url of [studio + '.evil', studio + '?file=1', 'https://test/studio.html'])
    assert.notEqual(listener({ type: 'native', href: 'file:///D:/notes.md' }, { ...sender, url },
      () => assert.fail('untrusted native sender')), true);
});

test('workspace runtime and manifest do not restore the retired automatic grouping mechanism', async () => {
  const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const router = await readFile(new URL('../extension/workspace-routing.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(background + router, /createStudioTabGrouper|tabs\.group|tabGroups\./);
  assert.equal(manifest.permissions.includes('tabGroups'), false);
});
