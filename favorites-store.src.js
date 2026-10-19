function directoryStudioFavoriteIntent(value, intent) {
  const items = directoryStudioFavorites(value);
  const href = directoryStudioNormalizeURL(intent.href, true);
  if (!href) return items;
  const index = items.findIndex(item => item.href === href);
  if (intent.type === 'toggle') return directoryStudioFavoriteIntent(items, { ...intent, type: index >= 0 ? 'remove' : 'add' });
  if (intent.type === 'add' && index < 0) {
    if (items.length >= 200) throw new Error('最多收藏 200 个目录，请先移除不需要的收藏。');
    items.push({ href, label: intent.label });
  } else if (intent.type === 'remove' && index >= 0) items.splice(index, 1);
  else if (intent.type === 'rename' && index >= 0 && typeof intent.label === 'string' && intent.label.trim()) items[index].label = intent.label;
  else if (intent.type === 'move' && index >= 0 && [-1, 1].includes(intent.direction)) {
    const next = index + intent.direction;
    if (next >= 0 && next < items.length) [items[index], items[next]] = [items[next], items[index]];
  }
  return directoryStudioFavorites(items);
}
function directoryStudioCreateFavoritesStore(api, initial, changed) {
  let current = directoryStudioFavorites(initial);
  let notified = false;
  let revision = 0;
  let disposed = false;
  let queue = Promise.resolve();
  const publish = () => { if (!disposed) changed(directoryStudioFavorites(current)); };
  const listener = api.subscribe(value => {
    if (disposed) return;
    notified = true; revision++; current = directoryStudioFavorites(value); publish();
  });
  async function refresh() {
    const previous = revision;
    const stored = directoryStudioFavorites(await api.read());
    // GM reads may return this context's old cache. A delivered change notification is newer evidence.
    if (!notified && revision === previous) current = stored;
    return directoryStudioFavorites(current);
  }
  return {
    snapshot: () => directoryStudioFavorites(current),
    refresh: () => refresh().then(() => publish()),
    mutate(intent) {
      const pending = queue.catch(() => {}).then(async () => {
        if (disposed) return;
        await refresh();
        if (disposed) return;
        const next = directoryStudioFavoriteIntent(current, intent);
        await api.write(next);
        if (disposed) return;
        notified = true; revision++; current = next; publish();
      });
      queue = pending;
      return pending;
    },
    dispose() { disposed = true; api.unsubscribe(listener); }
  };
}
