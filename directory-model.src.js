const DIRECTORY_STUDIO_CONTEXT_KEY = 'directoryStudioV1';
function directoryStudioNormalizeURL(value, directory = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.username || url.password) return null;
    url.search = ''; url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, escaped => {
      const character = String.fromCharCode(parseInt(escaped.slice(1), 16));
      return /[a-z0-9_.~-]/i.test(character) ? character : escaped.toUpperCase();
    });
    url.pathname = url.pathname.replace(/^\/([a-z]):/i, (_, drive) => '/' + drive.toUpperCase() + ':');
    if (directory && !url.pathname.endsWith('/')) return null;
    return url.href;
  } catch (_) { return null; }
}
function directoryStudioFavorites(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const href = directoryStudioNormalizeURL(item.href, true);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    let fallback;
    try { fallback = decodeURIComponent(new URL(href).pathname); } catch (_) { fallback = href; }
    result.push({ href, label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 120) : fallback.slice(-120) });
  }
  return result;
}
function directoryStudioMatches(entry, state, tokens = state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)) {
  return (state.filter === 'all' || entry.isDirectory === (state.filter === 'folders')) &&
    tokens.every(token => (entry.searchName || entry.name.toLocaleLowerCase()).includes(token));
}
function directoryStudioContext(value, href) {
  if (!value || typeof value !== 'object' || value.href !== href || value.version !== 1) return null;
  const choice = (key, values, fallback) => values.includes(value[key]) ? value[key] : fallback;
  const text = (key, limit) => typeof value[key] === 'string' ? value[key].slice(0, limit) : '';
  return {
    query: text('query', 1000), filter: choice('filter', ['all', 'files', 'folders'], 'all'),
    sort: choice('sort', ['name', 'modified', 'size'], 'name'), direction: choice('direction', ['asc', 'desc'], 'asc'),
    view: choice('view', ['list', 'grid'], 'list'), focus: text('focus', 8192),
    anchor: text('anchor', 8192), offset: Number.isFinite(value.offset) ? Math.max(-10000, Math.min(10000, value.offset)) : 0,
    scroll: Number.isFinite(value.scroll) ? Math.max(0, Math.min(1e8, value.scroll)) : 0,
    page: Number.isSafeInteger(value.page) && value.page >= 0 ? Math.min(1000000, value.page) : 0
  };
}
function directoryStudioMergeContext(previous, value) {
  if (previous !== null && Object.prototype.toString.call(previous) !== '[object Object]') return null;
  return { ...previous, [DIRECTORY_STUDIO_CONTEXT_KEY]: value };
}
