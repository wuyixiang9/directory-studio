const DIRECTORY_STUDIO_TEXT_EXTENSIONS = new Set('txt log csv tsv env md markdown json jsonc js mjs cjs jsx ts tsx css scss yaml yml toml ini cfg conf properties py pyw rs go c h cpp hpp cc cxx hxx java cs sh bash zsh ps1 psm1 psd1 sql bat cmd xml'.split(' '));
const directoryStudioResourceCache = new Map();
const directoryStudioMetrics = { started: performance.now(), resources: Object.create(null), interactive: null };
function directoryStudioTextEligible(url, mime) {
  const extension = url.pathname.split('.').pop().toLowerCase();
  return url.protocol === 'file:' && !url.pathname.endsWith('/') && DIRECTORY_STUDIO_TEXT_EXTENSIONS.has(extension) &&
    !/html|xml|svg/.test(mime) && (mime.startsWith('text/') || /^application\/(?:json|javascript|x-javascript|ecmascript|yaml|x-yaml|toml|sql|x-sh|x-powershell)$/.test(mime));
}
function directoryStudioNativeText(doc, mime) {
  const body = doc.body;
  if (!body || body.id || body.className.trim() || body.isContentEditable) return null;
  const elements = [...body.children];
  const pres = elements.filter(node => node.tagName === 'PRE');
  if (pres.length !== 1 || pres[0].children.length || pres[0].isContentEditable) return null;
  const formatters = mime === 'application/json' ? elements.filter(node =>
    node.tagName === 'DIV' && node.className === 'json-formatter-container' &&
    !node.id && node.childNodes.length === 0 && node.shadowRoot === null && !node.isContentEditable) : [];
  if (formatters.length > 1) return null;
  const nativeNodes = [pres[0], ...formatters];
  if (elements.some(node => !nativeNodes.includes(node) && node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE')) return null;
  if ([...body.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) return null;
  return { pre: pres[0], nativeNodes };
}
function directoryStudioTextWithinLimit(text) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024 || new Blob([text]).size > 2 * 1024 * 1024) return false;
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char === 10 || char === 13) lines++;
    if (char === 13 && text.charCodeAt(index + 1) === 10) index++;
    if (lines > 50000) return false;
  }
  return true;
}
function directoryStudioAfterListPaint(restore, complete) {
  let canceled = false;
  let second;
  const first = requestAnimationFrame(() => {
    if (canceled) return;
    restore();
    second = requestAnimationFrame(() => { if (!canceled) complete(); });
  });
  return () => { canceled = true; cancelAnimationFrame(first); cancelAnimationFrame(second); };
}
function directoryStudioResourceText(name) {
  if (typeof GM_getResourceText !== 'function') throw new Error('Install-cached resources are unavailable. Reinstall the local candidate.');
  const text = GM_getResourceText(name);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Missing install-cached resource: ' + name);
  const counts = directoryStudioMetrics.resources[name] || { reads: 0, executions: 0 };
  counts.reads++;
  directoryStudioMetrics.resources[name] = counts;
  return text;
}
function directoryStudioLoadResource(name) {
  if (!['editor', 'markdown'].includes(name)) return Promise.reject(new Error('Unknown executable resource'));
  if (!directoryStudioResourceCache.has(name)) {
    const pending = Promise.resolve().then(() => {
      const text = directoryStudioResourceText(name);
      const environment = {
        getResourceText: directoryStudioResourceText,
        GM_getValue: typeof GM_getValue === 'function' ? GM_getValue : undefined,
        GM_setValue: typeof GM_setValue === 'function' ? GM_setValue : undefined,
        GM_setClipboard: typeof GM_setClipboard === 'function' ? GM_setClipboard : undefined,
        nativeText: directoryStudioNativeText
      };
      const result = new Function('environment', text)(environment);
      directoryStudioMetrics.resources[name].executions++;
      return result;
    });
    directoryStudioResourceCache.set(name, pending);
    pending.catch(() => directoryStudioResourceCache.delete(name));
  }
  return directoryStudioResourceCache.get(name);
}
function startLocalTextStudio() {
  const mime = document.contentType.toLowerCase().split(';')[0].trim();
  if (!directoryStudioTextEligible(new URL(location.href), mime)) return false;
  const token = Symbol.for('directory-studio.text.loader');
  if (document[token]) return true;
  document[token] = true;
  let finished = false;
  let abandoned = false;
  const stop = () => { clearTimeout(timer); document.removeEventListener('DOMContentLoaded', ready); };
  const abandon = () => { abandoned = true; finished = true; stop(); };
  const ready = async () => {
    if (finished || document.readyState === 'loading') return;
    finished = true; stop();
    const native = directoryStudioNativeText(document, mime);
    if (!native) return;
    if (!directoryStudioTextWithinLimit(native.pre.textContent)) {
      const note = document.createElement('aside'); note.setAttribute('role', 'status');
      note.textContent = 'Directory Studio: file exceeds 2 MiB or 50,000 lines. Native text is unchanged.';
      document.body.append(note); return;
    }
    try {
      const [editor, markdown] = await Promise.all([directoryStudioLoadResource('editor'), directoryStudioLoadResource('markdown')]);
      if (abandoned) return;
      editor.startLoadedTextStudio({ CodeMirror: editor.CodeMirror, ...markdown, css: directoryStudioResourceText('editorCSS') });
    } catch (_) {
      if (abandoned) return;
      const note = document.createElement('aside');
      note.setAttribute('role', 'status');
      note.textContent = 'Directory Studio: editor resources could not be loaded. Native text is unchanged; reinstall the local candidate.';
      document.body.append(note);
    }
  };
  const timer = setTimeout(abandon, 5000);
  document.addEventListener('DOMContentLoaded', ready, { once: true });
  window.addEventListener('pagehide', abandon, { once: true });
  ready();
  return true;
}
