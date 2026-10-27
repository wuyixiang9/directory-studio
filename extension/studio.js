import { localURL, fileKind, pathLabel } from './model.js';
import { readLocal, readPicked, pickDocument, persistDocument } from './files.js';

const $ = (id) => document.getElementById(id);
const make = (tag, className = '', text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const shared = window.studioShared;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const preferences = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Nonessential preference. */
    }
  }
};
// theme.js uses a plain string so it can restore the initial palette before the first paint.
preferences.get = ((original) =>
  function (key, fallback) {
    if (key === 'directory-studio.theme') return document.documentElement.dataset.theme;
    return original.call(this, key, fallback);
  })(preferences.get);
preferences.set = ((original) =>
  function (key, value) {
    if (key === 'directory-studio.theme') {
      try {
        localStorage.setItem(key, value);
      } catch {}
      document.documentElement.dataset.theme = value;
      return;
    }
    original.call(this, key, value);
  })(preferences.set);
window.studioPreferences = preferences;
// Remember each layout independently; resizing restores that layout's choice without overwriting it.
const narrowSidebar = window.matchMedia('(max-width: 700px)');
const sidebarPreference = () =>
  narrowSidebar.matches ? 'extension.sidebarNarrowCollapsed' : 'extension.sidebarCollapsed';
function applySidebar() {
  const collapsed = preferences.get(sidebarPreference(), narrowSidebar.matches) === true;
  if (collapsed && $('sidebar').contains(document.activeElement)) $('toggle-sidebar').focus();
  $('sidebar').hidden = collapsed;
  $('toggle-sidebar').setAttribute('aria-expanded', String(!collapsed));
  $('toggle-sidebar').title = collapsed ? '展开常用目录' : '收起常用目录';
  menu.close();
}
const state = {
  href: '',
  directory: '',
  entries: [],
  query: '',
  filter: 'all',
  sort: preferences.get('extension.sort', 'name'),
  direction: preferences.get('extension.direction', 'asc'),
  view: preferences.get('extension.view', 'list'),
  page: 0
};
let editor = null,
  documentData = null,
  readJob = null,
  generation = 0,
  editorLoader = null,
  favorites = [],
  historyIndex = 0,
  historyRestore = null,
  loadingTimer = null;
const viewer = shared.directoryStudioCreateImageViewer({
  root: $('main'),
  restoreFocus: (href) => {
    [...$('entries').querySelectorAll('a')]
      .find((node) => node.href === href)
      ?.focus({ preventScroll: true });
  }
});
const menu = shared.directoryStudioCreateFavoritesMenu({
  root: document.body,
  getFavorites: () => favorites,
  changeFavorite: (intent) => changeFavorite(intent),
  renameLabel: (item) => prompt('收藏标签（不会修改目录名）', item.label)
});
const status = (text) => {
  $('status').textContent = text;
};
function targetHash(href) {
  return '#' + encodeURIComponent(href);
}
function fromHash() {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return '';
  }
}
function validTarget(value) {
  return localURL(value) || (/^picked:[a-f0-9-]{36}$/.test(value) ? value : null);
}
function canLeave() {
  if (editor?.isSaving()) {
    status('正在保存，请等待保存结束。');
    return false;
  }
  return !editor?.isDirty() || confirm('当前文件有未保存的修改。离开并丢弃这些修改？');
}
function captureContext() {
  const snapshot = {
    query: state.query,
    filter: state.filter,
    sort: state.sort,
    direction: state.direction,
    view: state.view,
    page: state.page,
    scroll: $('entries').scrollTop,
    focus:
      document.activeElement?.closest('.entry')?.href ||
      (document.activeElement === $('search') ? 'search' : '')
  };
  history.replaceState(
    { ...history.state, index: historyIndex, href: state.href, context: snapshot },
    '',
    location.href
  );
}
async function navigate(value, { replace = false, picked = null } = {}) {
  const href = validTarget(value);
  if (!href) {
    status('请输入有效的本地 file 路径或 Windows 路径。');
    return;
  }
  if (!canLeave()) return;
  if (!href.startsWith('picked:') && !fileKind(href)) {
    await nativeOpen(href);
    return;
  }
  captureContext();
  if (replace) history.replaceState({ index: historyIndex, href }, '', targetHash(href));
  else {
    historyIndex++;
    history.pushState({ index: historyIndex, href }, '', targetHash(href));
  }
  await renderTarget(href, null, picked);
}
async function loadEditor() {
  if (!editorLoader)
    editorLoader = Promise.all([
      new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('editor.js');
        script.onload = resolve;
        script.onerror = () => {
          script.remove();
          reject(Error('离线编辑器资源加载失败。'));
        };
        document.head.append(script);
      }),
      fetch(chrome.runtime.getURL('editor.css')).then((response) => response.text())
    ])
      .then(([, css]) => css)
      .catch((error) => {
        editorLoader = null;
        throw error;
      });
  return editorLoader;
}
function setSections(name) {
  for (const section of ['directory', 'welcome', 'editor-slot', 'failure'])
    $(section).hidden = section !== name;
}
function showPath(href, data) {
  const picked = href.startsWith('picked:');
  $('path').value = picked
    ? '已授权文件：' + (data?.name || '读取中') + '（浏览器不提供绝对路径）'
    : pathLabel(href);
  for (const id of ['native', 'up', 'copy-path']) $(id).disabled = picked;
  $('breadcrumbs').replaceChildren();
  if (picked) {
    $('breadcrumbs').append(make('span', '', data?.name || '已授权文件'));
    return;
  }
  const url = new URL(href);
  const parts = url.pathname.split('/').filter(Boolean);
  const root = new URL(url.href);
  root.pathname = '/';
  const rootLink = make('a', '', url.hostname ? '\\\\' + url.hostname : '/');
  rootLink.href = root.href;
  $('breadcrumbs').append(rootLink);
  parts.forEach((part, index) => {
    $('breadcrumbs').append(make('span', '', '/'));
    let name;
    try {
      name = decodeURIComponent(part);
    } catch {
      name = part;
    }
    if (index === parts.length - 1) {
      $('breadcrumbs').append(make('span', '', name));
      return;
    }
    const link = make('a', '', name);
    const target = new URL(url.href);
    target.pathname = '/' + parts.slice(0, index + 1).join('/') + '/';
    link.href = target.href;
    $('breadcrumbs').append(link);
  });
}
async function renderTarget(href, context = null, preloaded = null) {
  const token = ++generation;
  readJob?.abort();
  readJob = new AbortController();
  const signal = readJob.signal;
  viewer.close(false);
  menu.close();
  $('editor-slot').inert = true;
  // Keep the currently painted content until the next view is ready. Fast reads need no visual cue.
  clearTimeout(loadingTimer);
  $('loading').hidden = true;
  $('main').setAttribute('aria-busy', 'true');
  loadingTimer = setTimeout(() => {
    if (token === generation) $('loading').hidden = false;
  }, 180);
  try {
    let kind = href.startsWith('picked:') ? 'text' : fileKind(href);
    let dir = kind === 'directory' ? href : kind === 'image' ? new URL('./', href).href : '';
    const result =
      preloaded ||
      (href.startsWith('picked:') ? await readPicked(href) : await readLocal(dir || href, { signal }));
    if (token !== generation) return;
    if (kind === 'text' && result.kind === 'directory') {
      kind = 'directory';
      href = result.href;
      dir = href;
      history.replaceState({ ...history.state, href }, '', targetHash(href));
    }
    const css = kind === 'text' ? await loadEditor() : null;
    if (token !== generation) return;
    // Keep the old editor alive until replacement data is ready. A failed read cannot discard edits.
    editor?.dispose();
    editor = null;
    documentData = null;
    $('editor-slot').replaceChildren();
    state.href = href;
    state.directory = dir;
    showPath(href, result);
    if (kind === 'text') {
      setSections('editor-slot');
      documentData = result;
      const editorHref = result.picked ? 'file:///__authorized__/' + encodeURIComponent(result.name) : href;
      window.mountStudioEditor({
        href: editorHref,
        text: result.text,
        mount: $('editor-slot'),
        css,
        save: (text) => persistDocument(href, result, text),
        ready: (api) => {
          editor = api;
        }
      });
      if (!editor) throw Error('编辑器未能启动。');
      status(
        result.picked
          ? '已授权文件 · UTF-8 · 文件正文不持久化'
          : '只读打开 · Ctrl+S 可选择原文件并授权保存 · 下载副本不会覆盖原文件'
      );
    } else {
      state.entries = result.entries;
      state.query = context?.query || '';
      state.filter = context?.filter || 'all';
      state.page = context?.page || 0;
      if (context)
        for (const key of ['sort', 'direction', 'view']) if (context[key]) state[key] = context[key];
      $('search').value = state.query;
      $('filter').value = state.filter;
      $('sort').value = state.sort;
      setSections('directory');
      renderEntries();
      $('entries').scrollTop = context?.scroll || 0;
      if (context?.focus === 'search') $('search').focus({ preventScroll: true });
      else if (context?.focus)
        [...$('entries').querySelectorAll('a')]
          .find((link) => link.href === context.focus)
          ?.focus({ preventScroll: true });
      if (kind === 'image') viewer.open(shared.directoryStudioImageSequence(filteredEntries()), href);
      status('本地目录 · ' + state.entries.length + ' 项 · 不递归扫描');
    }
    document.title = (result.picked ? result.name : pathLabel(href)) + ' — Directory Studio';
    renderFavorites();
    captureContext();
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    // Failed navigation restores the previous usable document and URL.
    if (state.href) {
      history.replaceState({ ...history.state, href: state.href }, '', targetHash(state.href));
      showPath(state.href, documentData);
      status(String(error.message || error));
    } else {
      setSections('failure');
      $('failure-detail').textContent = String(error.message || error);
      $('path').value = href;
      status('读取失败；没有修改文件。');
    }
  } finally {
    if (token === generation) {
      clearTimeout(loadingTimer);
      $('loading').hidden = true;
      $('main').setAttribute('aria-busy', 'false');
      $('editor-slot').inert = false;
      await updatePermission();
    }
  }
}
function filteredEntries() {
  const tokens = state.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return state.entries
    .filter(
      (entry) =>
        (state.filter === 'all' || entry.isDirectory === (state.filter === 'folders')) &&
        tokens.every((token) => entry.name.toLocaleLowerCase().includes(token))
    )
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const cmp =
        state.sort === 'name'
          ? collator.compare(a.name, b.name)
          : a[state.sort] - b[state.sort] || collator.compare(a.name, b.name);
      return state.direction === 'desc' ? -cmp : cmp;
    });
}
function renderEntries() {
  const entries = filteredEntries(),
    pages = Math.max(1, Math.ceil(entries.length / 160));
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  const fragment = document.createDocumentFragment();
  for (const entry of entries.slice(state.page * 160, state.page * 160 + 160)) {
    const row = make('a', 'entry');
    row.href = entry.href;
    row.title = pathLabel(entry.href);
    row.dataset.directory = String(entry.isDirectory);
    row.setAttribute('role', 'listitem');
    const name = make('span', 'name');
    name.append(
      make('span', 'icon', entry.isDirectory ? '▰' : fileKind(entry.href) === 'image' ? '▧' : '▤'),
      make('span', 'filename', entry.name)
    );
    row.append(
      name,
      make('span', 'meta', entry.isDirectory ? '—' : sizeLabel(entry.size)),
      make(
        'span',
        'meta',
        entry.modified ? new Date(entry.modified).toLocaleString('zh-CN', { hour12: false }) : '—'
      )
    );
    fragment.append(row);
  }
  if (!entries.length) fragment.append(make('p', 'empty', '当前目录没有符合条件的条目。'));
  $('entries').replaceChildren(fragment);
  $('entries').dataset.view = state.view;
  $('count').textContent = entries.length + ' / ' + state.entries.length + ' 项';
  $('page').textContent = state.page + 1 + ' / ' + pages;
  $('previous').disabled = state.page === 0;
  $('next').disabled = state.page >= pages - 1;
  $('direction').textContent = state.direction === 'asc' ? '升序' : '降序';
  $('view').textContent = state.view === 'list' ? '网格视图' : '列表视图';
}
function sizeLabel(size) {
  return size < 1024
    ? size + ' B'
    : size < 1024 * 1024
      ? (size / 1024).toFixed(1) + ' KB'
      : (size / 1024 / 1024).toFixed(1) + ' MB';
}
function renderFavorites() {
  $('favorites').replaceChildren();
  for (const item of favorites) {
    const row = make('div', 'favorite-item');
    row.setAttribute('aria-current', String(item.href === state.directory));
    const link = make('a', '', item.label);
    link.href = item.href;
    link.title = pathLabel(item.href);
    const more = make('button', '', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', item.label + '的更多操作');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => menu.toggle(more, item.href));
    more.addEventListener('keydown', (event) => menu.triggerKey(event, more, item.href));
    row.append(link, more);
    $('favorites').append(row);
  }
  if (!favorites.length) $('favorites').append(make('p', '', '打开目录后，点击 ＋ 收藏。'));
  $('favorite').disabled = !state.directory;
  $('favorite').textContent = favorites.some((item) => item.href === state.directory) ? '−' : '＋';
}
async function changeFavorite(intent) {
  try {
    const current = await chrome.storage.local.get('favorites');
    favorites = shared.directoryStudioFavoriteIntent(current.favorites, intent);
    await chrome.storage.local.set({ favorites });
    renderFavorites();
  } catch (error) {
    status(error.message);
  }
}
async function updatePermission() {
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  $('permission').hidden = allowed;
  return allowed;
}
async function nativeOpen(href = state.href || validTarget(fromHash())) {
  if (!localURL(href) || !canLeave()) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'native', href });
    if (!response?.ok) throw Error(response?.error || '原生打开失败。');
  } catch (error) {
    status(error.message);
  }
}
$('toggle-sidebar').addEventListener('click', () => {
  preferences.set(sidebarPreference(), !$('sidebar').hidden);
  applySidebar();
});
narrowSidebar.addEventListener('change', applySidebar);
applySidebar();
$('path-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void navigate($('path').value);
});
$('up').addEventListener('click', () => {
  if (state.href && !state.href.startsWith('picked:'))
    void navigate(new URL(state.directory ? '../' : './', state.href).href);
});
$('native').addEventListener('click', () => void nativeOpen());
$('failure-native').addEventListener('click', () => void nativeOpen());
$('copy-path').addEventListener('click', () => {
  if (state.href)
    navigator.clipboard.writeText(pathLabel(state.href)).then(
      () => status('已复制当前路径'),
      () => status('复制失败，可在路径栏手动选择。')
    );
});
$('search').addEventListener('input', () => {
  state.query = $('search').value;
  state.page = 0;
  renderEntries();
});
for (const key of ['filter', 'sort'])
  $(key).addEventListener('change', () => {
    state[key] = $(key).value;
    state.page = 0;
    preferences.set('extension.' + key, state[key]);
    renderEntries();
  });
$('direction').addEventListener('click', () => {
  state.direction = state.direction === 'asc' ? 'desc' : 'asc';
  preferences.set('extension.direction', state.direction);
  renderEntries();
});
$('view').addEventListener('click', () => {
  state.view = state.view === 'list' ? 'grid' : 'list';
  preferences.set('extension.view', state.view);
  renderEntries();
});
for (const [id, delta] of [
  ['previous', -1],
  ['next', 1]
])
  $(id).addEventListener('click', () => {
    state.page += delta;
    renderEntries();
    $('entries').scrollTop = 0;
  });
$('favorite').addEventListener('click', () => {
  if (state.directory)
    void changeFavorite({
      type: 'toggle',
      href: state.directory,
      label:
        pathLabel(state.directory)
          .replace(/[\\/]$/, '')
          .split(/[\\/]/)
          .pop() || state.directory
    });
});
$('theme').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  preferences.set('directory-studio.theme', theme);
  editor?.setTheme(theme);
});
$('capture').addEventListener('change', () => {
  void chrome.storage.local.set({ autoCapture: $('capture').checked });
  status($('capture').checked ? '已开启外部路径自动接管' : '已暂停外部路径自动接管；当前工作台仍可使用');
});
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('settings').addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
});
$('retry').addEventListener('click', async () => {
  if (await updatePermission()) {
    const href = validTarget(fromHash());
    if (href) void renderTarget(href);
  }
});
$('pick-file').addEventListener('click', async () => {
  if (!canLeave()) return;
  try {
    const key = await pickDocument();
    const data = await readPicked(key);
    await navigate(key, { picked: data });
  } catch (error) {
    if (error.name !== 'AbortError') status(error.message);
  }
});
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  const href = localURL(link.href);
  if (!href) return;
  if (documentData?.picked && link.closest('#editor-slot') && link.dataset.studioRelative === 'true') {
    event.preventDefault();
    status('浏览器未提供授权文件的绝对路径，无法解析相对本地链接；请在路径栏输入完整路径。');
    return;
  }
  if (event.defaultPrevented || event.button !== 0) return;
  event.preventDefault();
  if (link.hash && href === state.href) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    void chrome.tabs.create({
      url: fileKind(href) ? chrome.runtime.getURL('studio.html') + targetHash(href) : href,
      active: event.shiftKey
    });
    return;
  }
  if (link.classList.contains('iv-original')) {
    void nativeOpen(href);
    return;
  }
  if (fileKind(href) === 'image' && state.directory && !link.closest('#editor-slot'))
    viewer.open(shared.directoryStudioImageSequence(filteredEntries()), href);
  else void navigate(href);
});
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  const editable = event.target.closest('input,textarea,select,[contenteditable=true]');
  if (!editable && event.key === '/' && !event.ctrlKey && !event.metaKey && !$('directory').hidden) {
    event.preventDefault();
    $('search').focus();
  }
  if (event.key === 'Escape' && event.target === $('search')) {
    if ($('search').value) {
      $('search').value = '';
      state.query = '';
      renderEntries();
    } else $('search').blur();
  }
  if (event.altKey && event.key === 'ArrowUp' && !editable) {
    event.preventDefault();
    $('up').click();
  }
});
window.addEventListener('popstate', (event) => {
  // A tabs.update back into this already-open Studio may only change its hash.
  // Such an external entry has no app state; adopt it instead of restoring the old URL.
  const inbound = validTarget(fromHash());
  const nextIndex = Number.isInteger(event.state?.index) ? event.state.index : historyIndex + 1;
  if (historyRestore !== null && nextIndex === historyRestore) {
    historyRestore = null;
    return;
  }
  if (!canLeave()) {
    historyRestore = historyIndex;
    history.go(historyIndex - nextIndex);
    return;
  }
  historyIndex = nextIndex;
  const href = validTarget(event.state?.href) || inbound;
  if (!Number.isInteger(event.state?.index))
    history.replaceState({ index: historyIndex, href: href || '' }, '', location.href);
  if (href) void renderTarget(href, event.state?.context);
  else {
    editor?.dispose();
    editor = null;
    documentData = null;
    state.href = '';
    state.directory = '';
    setSections('welcome');
    $('breadcrumbs').replaceChildren();
    $('path').value = '';
    renderFavorites();
  }
});
window.addEventListener('pagehide', () => {
  clearTimeout(loadingTimer);
  readJob?.abort();
  viewer.close(false);
  menu.close();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.favorites) {
    favorites = shared.directoryStudioFavorites(changes.favorites.newValue);
    menu.close();
    renderFavorites();
  }
  if (changes.autoCapture) $('capture').checked = changes.autoCapture.newValue !== false;
});
const settings = await chrome.storage.local.get(['favorites', 'autoCapture']);
favorites = shared.directoryStudioFavorites(settings.favorites);
$('capture').checked = settings.autoCapture !== false;
renderFavorites();
await updatePermission();
historyIndex = Number.isInteger(history.state?.index) ? history.state.index : 0;
const initial = validTarget(fromHash());
history.replaceState({ ...history.state, index: historyIndex, href: initial || '' }, '', location.href);
if (initial) await renderTarget(initial, history.state.context);
