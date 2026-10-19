import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await Promise.all(['directory-model.src.js', 'favorites-store.src.js'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const context = vm.createContext({ URL });
new vm.Script(source).runInContext(context);
const copy = value => JSON.parse(JSON.stringify(value));
const favorite = name => ({ href: 'file:///C:/' + name + '/', label: name });

test('two contexts retain sequential remote additions when another removes renames or reorders using a stale GM cache', async () => {
  let stored = [favorite('A'), favorite('B')];
  const listeners = new Map();
  const create = name => {
    const staleCache = copy(stored);
    return context.directoryStudioCreateFavoritesStore({
      read: async () => copy(staleCache),
      write: async value => {
        stored = copy(value);
        for (const [other, callback] of listeners) if (other !== name) callback(copy(stored));
      },
      subscribe(callback) { listeners.set(name, callback); return name; },
      unsubscribe(id) { listeners.delete(id); }
    }, staleCache, () => {});
  };
  const a = create('a'), b = create('b');
  await a.mutate({ type: 'add', ...favorite('X') });
  await b.mutate({ type: 'remove', href: favorite('A').href });
  assert.deepEqual(stored.map(item => item.label), ['B', 'X']);
  await b.mutate({ type: 'move', href: favorite('X').href, direction: -1 });
  assert.deepEqual(stored.map(item => item.label), ['X', 'B']);
  await a.mutate({ type: 'rename', href: favorite('B').href, label: 'Beta' });
  assert.deepEqual(stored.map(item => item.label), ['X', 'Beta']);
  await b.mutate({ type: 'rename', href: favorite('A').href, label: 'stale row' });
  assert.deepEqual(stored.map(item => item.label), ['X', 'Beta']);
  a.dispose(); b.dispose(); assert.equal(listeners.size, 0);
});

test('notification arriving during an awaited read takes precedence over that context cached read result', async () => {
  let notify, release;
  const pendingRead = new Promise(resolve => { release = resolve; });
  let written;
  const store = context.directoryStudioCreateFavoritesStore({
    read: () => pendingRead,
    write: async value => { written = copy(value); },
    subscribe(callback) { notify = callback; return 1; },
    unsubscribe() {}
  }, [favorite('A')], () => {});
  const pending = store.mutate({ type: 'add', ...favorite('Y') });
  await Promise.resolve(); await Promise.resolve();
  notify([favorite('A'), favorite('X')]);
  release([favorite('A')]); await pending;
  assert.deepEqual(written.map(item => item.label), ['A', 'X', 'Y']);
});

test('mutation intents use stable href identity rather than indices captured by old rows', () => {
  const current = [favorite('New'), favorite('A'), favorite('B')];
  const result = context.directoryStudioFavoriteIntent(current, { type: 'remove', href: favorite('B').href });
  assert.deepEqual(copy(result).map(item => item.label), ['New', 'A']);
  const moved = context.directoryStudioFavoriteIntent(current, { type: 'move', href: favorite('B').href, direction: -1 });
  assert.deepEqual(copy(moved).map(item => item.label), ['New', 'B', 'A']);
});

test('failed writes do not poison local state or the serial mutation queue', async () => {
  let fail = true;
  const store = context.directoryStudioCreateFavoritesStore({
    read: async () => [],
    write: async () => { if (fail) throw new Error('unavailable'); },
    subscribe() { return null; }, unsubscribe() {}
  }, [], () => {});
  await assert.rejects(store.mutate({ type: 'add', ...favorite('A') }), /unavailable/);
  assert.equal(store.snapshot().length, 0);
  fail = false;
  await store.mutate({ type: 'add', ...favorite('B') });
  assert.equal(store.snapshot()[0].label, 'B');
});

test('rapid same-context star toggles apply sequentially to the latest favorite state', async () => {
  const store = context.directoryStudioCreateFavoritesStore({
    read: async () => [],
    write: async () => {},
    subscribe() { return null; }, unsubscribe() {}
  }, [], () => {});
  await Promise.all([
    store.mutate({ type: 'toggle', ...favorite('A') }),
    store.mutate({ type: 'toggle', ...favorite('A') })
  ]);
  assert.equal(store.snapshot().length, 0);
});
