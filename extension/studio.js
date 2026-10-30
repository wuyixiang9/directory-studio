import { localURL, fileKind, pathLabel } from './model.js';
import { readLocal, readPicked, pickDocument, persistDocument } from './files.js';
import { recentExternalFiles, RECENT_EXTERNAL_FILES_KEY } from './recent-files.js';
import { studioLinkTarget, prepareStudioLink } from './navigation.js';

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
const studioURL = chrome.runtime.getURL('studio.html');
const linkTarget = (link) => link ? studioLinkTarget(link.href, studioURL) : null;
const prepareLinks = (root) => {
  if (root.matches?.('a[href]')) prepareStudioLink(root, studioURL);
  for (const link of root.querySelectorAll?.('a[href]') || []) prepareStudioLink(link, studioURL);
};
const linkObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') prepareLinks(mutation.target);
    else for (const node of mutation.addedNodes) prepareLinks(node);
  }
});
linkObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
prepareLinks(document.body);
// Remember each layout independently; resizing restores that layout's choice without overwriting it.
const narrowSidebar = window.matchMedia('(max-width: 700px)');
const sidebarPreference = () =>
  narrowSidebar.matches ? 'extension.sidebarNarrowCollapsed' : 'extension.sidebarCollapsed';
function applySidebar() {
  finishSidebarResize(false);
  const collapsed = preferences.get(sidebarPreference(), narrowSidebar.matches) === true;
  if ((collapsed && $('sidebar').contains(document.activeElement)) ||
      ((collapsed || narrowSidebar.matches) && document.activeElement === $('sidebar-resize'))) $('toggle-sidebar').focus();
  $('sidebar').hidden = collapsed;
  $('sidebar-resize').hidden = collapsed;
  $('toggle-sidebar').setAttribute('aria-expanded', String(!collapsed));
  $('toggle-sidebar').title = collapsed ? '展开文件与目录' : '收起文件与目录';
  menu.close();
  applySidebarWidth();
}
const sidebarSections = [
  ['open-heading', 'open-content', 'extension.openCollapsed'],
  ['favorites-heading', 'favorites', 'extension.favoritesCollapsed'],
  ['recent-heading', 'recent-files', 'extension.recentCollapsed']
];
function applySidebarSection(buttonId, contentId, key) {
  const collapsed = preferences.get(key, false) === true;
  const button = $(buttonId);
  const content = $(contentId);
  if (collapsed && content.contains(document.activeElement)) button.focus();
  content.hidden = collapsed;
  button.setAttribute('aria-expanded', String(!collapsed));
}
let sidebarWidth = preferences.get('extension.sidebarWidth', null);
if (typeof sidebarWidth !== 'number' || !Number.isFinite(sidebarWidth)) sidebarWidth = null;
let sidebarDrag = null;
function sidebarWidthBounds() {
  return { min: 170, max: Math.max(170, Math.min(480, $('sidebar').parentElement.clientWidth - 326)) };
}
function applySidebarWidth() {
  const { min, max } = sidebarWidthBounds();
  const fallback = window.innerWidth <= 1000 ? 170 : 220;
  const width = Math.round(Math.max(min, Math.min(max, sidebarWidth ?? fallback)));
  $('sidebar').style.setProperty('--sidebar-width', width + 'px');
  const handle = $('sidebar-resize');
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  handle.setAttribute('aria-valuenow', String(width));
  handle.tabIndex = narrowSidebar.matches || $('sidebar').hidden ? -1 : 0;
  return width;
}
function finishSidebarResize(commit) {
  if (!sidebarDrag) return;
  const drag = sidebarDrag;
  sidebarDrag = null;
  delete document.body.dataset.sidebarResizing;
  if (!commit) sidebarWidth = drag.width;
  else preferences.set('extension.sidebarWidth', sidebarWidth);
  const handle = $('sidebar-resize');
  if (handle.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
  applySidebarWidth();
}
function setupSidebar() {
  for (const section of sidebarSections) {
    applySidebarSection(...section);
    $(section[0]).addEventListener('click', () => {
      preferences.set(section[2], $(section[0]).getAttribute('aria-expanded') === 'true');
      applySidebarSection(...section);
      menu.close();
    });
  }
  const handle = $('sidebar-resize');
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || narrowSidebar.matches || $('sidebar').hidden || document.body.dataset.previewFullscreen === 'true') return;
    event.preventDefault();
    finishSidebarResize(false);
    handle.setPointerCapture(event.pointerId);
    sidebarDrag = { pointerId: event.pointerId, x: event.clientX, start: applySidebarWidth(), width: sidebarWidth };
    document.body.dataset.sidebarResizing = 'true';
    handle.focus();
  });
  handle.addEventListener('pointermove', (event) => {
    if (sidebarDrag?.pointerId !== event.pointerId) return;
    const { min, max } = sidebarWidthBounds();
    sidebarWidth = Math.max(min, Math.min(max, sidebarDrag.start + event.clientX - sidebarDrag.x));
    applySidebarWidth();
  });
  handle.addEventListener('pointerup', (event) => {
    if (sidebarDrag?.pointerId === event.pointerId) finishSidebarResize(true);
  });
  for (const type of ['pointercancel', 'lostpointercapture'])
    handle.addEventListener(type, (event) => {
      if (sidebarDrag?.pointerId === event.pointerId) finishSidebarResize(false);
    });
  handle.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebarDrag) {
      event.preventDefault();
      finishSidebarResize(false);
      return;
    }
    if (narrowSidebar.matches || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    finishSidebarResize(false);
    const { min, max } = sidebarWidthBounds();
    const step = event.shiftKey ? 40 : 10;
    sidebarWidth = event.key === 'Home' ? min : event.key === 'End' ? max :
      Math.max(min, Math.min(max, applySidebarWidth() + (event.key === 'ArrowLeft' ? -step : step)));
    applySidebarWidth();
    preferences.set('extension.sidebarWidth', sidebarWidth);
  });
  window.addEventListener('resize', () => {
    finishSidebarResize(false);
    if (narrowSidebar.matches && document.activeElement === handle) $('toggle-sidebar').focus();
    applySidebarWidth();
  });
  for (const type of ['blur', 'pagehide']) window.addEventListener(type, () => finishSidebarResize(false));
  new MutationObserver(() => {
    if (document.body.dataset.previewFullscreen === 'true') finishSidebarResize(false);
  }).observe(document.body, { attributes: true, attributeFilter: ['data-preview-fullscreen'] });
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
  recentFiles = [],
  recentRevision = 0,
  historyIndex = 0,
  loadingTimer = null,
  releaseEditorStatus = null;
const openDocuments = new Map();
let documentSequence = 0;
function renderOpenDocuments() {
  const tokens = $('open-search').value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const fragment = document.createDocumentFragment();
  for (const [href, item] of openDocuments) {
    const fullPath = item.data.picked ? '已授权文件（浏览器不提供绝对路径）' : pathLabel(href);
    const name = item.data.name || pathLabel(href).split(/[\\/]/).pop();
    if (!tokens.every(token => (name + ' ' + fullPath).toLocaleLowerCase().includes(token))) continue;
    const row = make('div', 'open-document');
    row.setAttribute('aria-current', String(href === state.href));
    const link = make('button', 'open-document-link');
    link.type = 'button';
    link.title = fullPath;
    link.append(make('strong', '', name + (item.api?.isDirty() ? ' *' : '')), make('small', '', fullPath));
    link.addEventListener('click', () => void navigate(href));
    const close = make('button', '', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭 ' + name);
    close.addEventListener('click', () => void closeDocument(href));
    row.append(link, close);
    fragment.append(row);
  }
  if (!fragment.childNodes.length) fragment.append(make('p', '', openDocuments.size ? '没有匹配的已打开文件。' : '打开的文件会保留在这里。'));
  $('open-documents').replaceChildren(fragment);
  $('open-count').textContent = String(openDocuments.size);
}
function canClose(items) {
  if (items.some(item => item.api?.isSaving())) {
    status('正在保存，请等待保存结束。');
    return false;
  }
  return !items.some(item => item.api?.isDirty()) || confirm('有未保存的修改。关闭并丢弃这些修改？');
}
function parkEditor() {
  releaseEditorStatus?.();
  releaseEditorStatus = null;
  editor?.setActive(false);
  editor = null;
  setPreviewFullscreen(false);
}
function cancelNavigation() {
  ++generation;
  readJob?.abort();
  clearTimeout(loadingTimer);
  $('loading').hidden = true;
  $('main').setAttribute('aria-busy', 'false');
  $('editor-slot').inert = false;
}
async function closeDocument(href) {
  const item = openDocuments.get(href);
  if (!item || !canClose([item])) return;
  cancelNavigation();
  const active = href === state.href;
  if (active) {
    viewer.close(false);
    parkEditor();
  }
  item.api?.dispose();
  item.mount?.remove();
  openDocuments.delete(href);
  if (active) {
    const next = [...openDocuments.keys()].pop();
    state.href = '';
    documentData = null;
    if (next) await navigate(next, { replace: true });
    else {
      state.directory = '';
      history.replaceState({ index: historyIndex, href: '' }, '', studioURL);
      setSections('welcome');
      $('breadcrumbs').replaceChildren();
      $('path').value = '';
      document.title = 'Directory Studio';
      status('就绪');
      renderFavorites();
    }
  }
  renderOpenDocuments();
}
const viewer = shared.directoryStudioCreateImageViewer({
  root: $('main'),
  restoreFocus: (href) => {
    [...$('entries').querySelectorAll('a')]
      .find((node) => linkTarget(node) === href)
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
function attachEditorStatus() {
  const host = $('local-text-studio');
  const originalStatus = host.querySelector('.lts-status');
  const notice = host.querySelector('.lts-notice');
  const noticeParent = notice.parentNode;
  const labels = [...originalStatus.children];
  const encoding = originalStatus.querySelector('.lts-encoding');
  const encodingText = encoding.textContent;
  const footer = $('app-status');
  const group = make('div', 'editor-status');
  encoding.textContent = 'UTF-8';
  group.append(...labels, notice);
  footer.prepend(group);
  footer.dataset.editor = 'true';
  // Return borrowed nodes before disposing their editor; shell status IDs never leave the footer.
  return () => {
    originalStatus.append(...labels);
    encoding.textContent = encodingText;
    noticeParent.append(notice);
    group.remove();
    delete footer.dataset.editor;
  };
}
let fullscreenShellState = null;
function setPreviewFullscreen(value) {
  if (value && !fullscreenShellState) {
    menu.close();
    const nodes = document.querySelectorAll('.topbar, #permission, #path-form, #sidebar, #breadcrumbs, #app-status');
    fullscreenShellState = new Map([...nodes].map(node => [node, node.inert]));
    for (const node of nodes) node.inert = true;
    document.body.dataset.previewFullscreen = 'true';
  } else if (!value && fullscreenShellState) {
    for (const [node, inert] of fullscreenShellState) node.inert = inert;
    fullscreenShellState = null;
    delete document.body.dataset.previewFullscreen;
  }
}
function disposeEditor() {
  parkEditor();
  for (const item of openDocuments.values()) item.api?.dispose();
  openDocuments.clear();
}
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
  return canClose([...openDocuments.values()]);
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
      linkTarget(document.activeElement?.closest('.entry')) ||
      (document.activeElement === $('search') ? 'search' : '')
  };
  history.replaceState(
    { ...history.state, index: historyIndex, href: state.href, context: snapshot },
    '',
    location.href
  );
}
async function navigate(value, { replace = false, picked = null, preloaded = null, context = null } = {}) {
  let href = validTarget(value);
  if (!href) {
    status('请输入有效的本地 file 路径或 Windows 路径。');
    return;
  }
  if (picked?.handle) {
    for (const [existing, item] of openDocuments) {
      if (item.data.handle && await picked.handle.isSameEntry(item.data.handle)) {
        href = existing;
        picked = null;
        break;
      }
    }
  }
  if (!href.startsWith('picked:') && !fileKind(href)) {
    await nativeOpen(href);
    return;
  }
  captureContext();
  if (replace || href === state.href) history.replaceState({ index: historyIndex, href }, '', targetHash(href));
  else {
    historyIndex++;
    history.pushState({ index: historyIndex, href }, '', targetHash(href));
  }
  return await renderTarget(href, context, picked || preloaded);
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
  const cached = openDocuments.get(href);
  context ||= cached?.context;
  const token = ++generation;
  readJob?.abort();
  readJob = new AbortController();
  const signal = readJob.signal;
  viewer.close(false);
  menu.close();
  editor?.exitPreviewFullscreen();
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
      cached?.data || preloaded ||
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
    // Retain each editor in the document: detaching would destroy diagram iframe state.
    let item = cached;
    if (kind === 'text' && !item) {
      const mount = make('div', 'workspace-document');
      mount.dataset.document = String(++documentSequence);
      $('editor-slot').append(mount);
      item = { data: result, mount, api: null };
      try {
        window.mountStudioEditor({
          href: result.picked ? 'file:///__authorized__/' + encodeURIComponent(result.name) : href,
          text: result.text,
          mount,
          css,
          save: (text) => persistDocument(href, result, text),
          setPreviewFullscreen,
          ready: (api) => { item.api = api; },
          changed: () => renderOpenDocuments()
        });
        if (!item.api) throw Error('编辑器未能启动。');
      } catch (error) {
        item.api?.dispose();
        mount.remove();
        throw error;
      }
    }
    parkEditor();
    documentData = null;
    state.href = href;
    state.directory = dir;
    showPath(href, result);
    if (kind === 'text') {
      setSections('editor-slot');
      documentData = result;
      openDocuments.set(href, item);
      editor = item.api;
      editor.setActive(true);
      editor.setTheme(document.documentElement.dataset.theme);
      releaseEditorStatus = attachEditorStatus();
      status('');
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
          .find((link) => linkTarget(link) === context.focus)
          ?.focus({ preventScroll: true });
      if (kind === 'image') viewer.open(shared.directoryStudioImageSequence(filteredEntries()), href);
      if (kind === 'image') openDocuments.set(href, { data: result, context });
      status('本地目录 · ' + state.entries.length + ' 项 · 不递归扫描');
    }
    document.title = (result.picked ? result.name : pathLabel(href)) + ' — Directory Studio';
    renderFavorites();
    renderOpenDocuments();
    captureContext();
    return true;
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
function renderRecentFiles() {
  const fragment = document.createDocumentFragment();
  for (const href of recentFiles) {
    const fullPath = pathLabel(href);
    const name = fullPath.split(/[\\/]/).pop() || fullPath;
    const link = make('a', '', name);
    link.href = studioURL + targetHash(href);
    link.title = fullPath;
    fragment.append(link);
  }
  if (!recentFiles.length) fragment.append(make('p', '', '暂无最近打开的文件。'));
  $('recent-files').replaceChildren(fragment);
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
setupSidebar();
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
$('theme').value = document.documentElement.dataset.theme;
$('theme').addEventListener('change', () => {
  const theme = $('theme').value;
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
  // Picking another file keeps every open editor and its unsaved edits.
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
  const href = linkTarget(link);
  if (!href) return;
  if (documentData?.picked && link.closest('#editor-slot') && link.dataset.studioRelative === 'true') {
    event.preventDefault();
    status('浏览器未提供授权文件的绝对路径，无法解析相对本地链接；请在路径栏输入完整路径。');
    return;
  }
  if (event.defaultPrevented || event.button !== 0) return;
  event.preventDefault();
  if ((link.dataset.studioFragment === 'true' || localURL(link.href) && link.hash) && href === state.href) return;
  const independentTarget = link.target === '_blank' && !link.classList.contains('iv-original');
  if (event.ctrlKey || event.metaKey || event.shiftKey || independentTarget) {
    const url = fileKind(href) ? studioURL + targetHash(href) : href;
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) void chrome.windows.create({ url });
    else void chrome.tabs.create({ url, active: Boolean(event.shiftKey || (!event.ctrlKey && !event.metaKey && independentTarget)) });
    return;
  }
  if (link.classList.contains('iv-original')) {
    void nativeOpen(href);
    return;
  }
  if (fileKind(href) === 'image' && state.directory && link.closest('#entries')) {
    void navigate(href, { preloaded: { entries: state.entries }, context: { ...state, scroll: $('entries').scrollTop } });
  } else void navigate(href);
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
  // History switches views without discarding any retained editor.
  historyIndex = nextIndex;
  const href = validTarget(event.state?.href) || inbound;
  if (!Number.isInteger(event.state?.index))
    history.replaceState({ index: historyIndex, href: href || '' }, '', location.href);
  if (href) void renderTarget(href, event.state?.context);
  else {
    cancelNavigation();
    viewer.close(false);
    menu.close();
    parkEditor();
    documentData = null;
    state.href = '';
    state.directory = '';
    setSections('welcome');
    $('breadcrumbs').replaceChildren();
    $('path').value = '';
    status('就绪');
    renderFavorites();
    renderOpenDocuments();
    document.title = 'Directory Studio';
  }
});
window.addEventListener('pagehide', (event) => {
  clearTimeout(loadingTimer);
  readJob?.abort();
  viewer.close(false);
  menu.close();
  if (!event.persisted) disposeEditor();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[RECENT_EXTERNAL_FILES_KEY]) {
    recentRevision++;
    recentFiles = recentExternalFiles(changes[RECENT_EXTERNAL_FILES_KEY].newValue);
    renderRecentFiles();
  }
  if (changes.favorites) {
    favorites = shared.directoryStudioFavorites(changes.favorites.newValue);
    menu.close();
    renderFavorites();
  }
  if (changes.autoCapture) $('capture').checked = changes.autoCapture.newValue !== false;
});
const initialRecentRevision = recentRevision;
const settings = await chrome.storage.local.get(['favorites', 'autoCapture', RECENT_EXTERNAL_FILES_KEY]).catch(() => ({}));
if (recentRevision === initialRecentRevision) recentFiles = recentExternalFiles(settings[RECENT_EXTERNAL_FILES_KEY]);
favorites = shared.directoryStudioFavorites(settings.favorites);
$('capture').checked = settings.autoCapture !== false;
renderFavorites();
renderRecentFiles();
await updatePermission();
$('open-search').addEventListener('input', renderOpenDocuments);
$('independent').addEventListener('click', () => {
  void chrome.tabs.create({ url: studioURL + (state.href ? targetHash(state.href) : '') });
});
renderOpenDocuments();
let workspaceId = null;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'workspaceOpen' || message.recipient !== workspaceId) return;
  const href = localURL(message.href);
  if (!href || !fileKind(href)) { respond({ opened: false }); return; }
  void navigate(href).then(opened => respond({ opened: opened === true }), () => respond({ opened: false }));
  return true;
});
historyIndex = Number.isInteger(history.state?.index) ? history.state.index : 0;
const initial = validTarget(fromHash());
history.replaceState({ ...history.state, index: historyIndex, href: initial || '' }, '', location.href);
if (initial) await renderTarget(initial, history.state.context);
const registration = await chrome.runtime.sendMessage({ type: 'studioReady' }).catch(() => null);
workspaceId = registration?.documentId;
