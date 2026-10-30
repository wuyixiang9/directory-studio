import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRouter, isStudioURL } from '../extension/workspace-routing.js';

const studio = 'chrome-extension://test/studio.html';
function fixture() {
  const tabs = new Map([[4, { id: 4, windowId: 1, index: 2 }], [7, { id: 7, windowId: 1, index: 1 }]]);
  let contexts = [...tabs.values()].map(tab => ({ tabId: tab.id, windowId: tab.windowId, frameId: 0,
    documentId: 'document-' + tab.id, documentUrl: studio }));
  const updates = [], created = [], messages = [];
  const api = {
    runtime: {
      getURL: name => 'chrome-extension://test/' + name,
      getContexts: async filter => contexts.filter(context =>
        (!filter.windowIds || filter.windowIds.includes(context.windowId)) &&
        (!filter.tabIds || filter.tabIds.includes(context.tabId)) &&
        (!filter.documentIds || filter.documentIds.includes(context.documentId))),
      sendMessage: async message => { messages.push(message); return { opened: true }; }
    },
    tabs: {
      get: async id => tabs.get(id),
      update: async (id, properties) => { updates.push([id, properties]); },
      create: async properties => { created.push(properties); return { id: 20 }; }
    }
  };
  return { api, tabs, updates, created, messages, router: createWorkspaceRouter(api),
    contexts(value) { contexts = value; } };
}

test('action reuses the leftmost verified workspace without changing its URL or user group', async () => {
  const f = fixture();
  f.tabs.get(7).groupId = 19;
  assert.equal(await f.router.focus(1), 7);
  assert.deepEqual(f.updates, [[7, { active: true }]]);
  assert.deepEqual(f.created, []);
  assert.equal(f.tabs.get(7).groupId, 19);
});

test('action creates a workspace only in the requested window when none exists', async () => {
  const f = fixture();
  assert.equal(await f.router.focus(8), 20);
  assert.deepEqual(f.created, [{ windowId: 8, url: studio }]);
});

test('handoff addresses an exact live extension document, not an unknown tab URL', async () => {
  const f = fixture();
  assert.equal(await f.router.open(1, 'file:///D:/notes.md', 4), true);
  assert.deepEqual(f.messages, [{ type: 'workspaceOpen', href: 'file:///D:/notes.md', recipient: 'document-7' }]);
  assert.deepEqual(f.updates, [[7, { active: true }]]);
});

test('pending navigation and discarded tabs cannot be selected as workspaces', async () => {
  const f = fixture();
  f.tabs.get(7).pendingUrl = 'https://example.org/';
  f.tabs.get(4).discarded = true;
  assert.equal(await f.router.open(1, 'file:///D:/notes.md'), false);
  assert.deepEqual(f.messages, []);
});

test('a closed destination after acknowledgment is not accepted as delivery', async () => {
  const f = fixture();
  f.api.runtime.sendMessage = async () => { f.contexts([]); return { opened: true }; };
  assert.equal(await f.router.open(1, 'file:///D:/notes.md'), false);
  assert.deepEqual(f.updates, []);
});

test('same-window handoffs serialize until each document is actually opened', async () => {
  const f = fixture();
  let finish;
  f.api.runtime.sendMessage = async message => {
    f.messages.push(message);
    if (message.href.endsWith('first.md')) return await new Promise(resolve => { finish = resolve; });
    return { opened: true };
  };
  const first = f.router.open(1, 'file:///D:/first.md');
  const second = f.router.open(1, 'file:///D:/second.md');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.messages.length, 1);
  finish({ opened: true });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.messages.length, 2);
});

test('workspace identity rejects foreign origins, lookalike paths and query routes', () => {
  assert.equal(isStudioURL(studio + '#file', studio), true);
  for (const url of ['https://test/studio.html', studio + '/child', studio + '?file=1', 'not a URL'])
    assert.equal(isStudioURL(url, studio), false);
});
