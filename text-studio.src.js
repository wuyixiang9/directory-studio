function normalizeLocalTextStudioTheme(value) {
  return ['light', 'dark', 'economist', 'vercel'].includes(value) ? value : 'light';
}

function startLoadedTextStudio(dependencies) {
  'use strict';
  // The extension supplies already-read UTF-8 text and owns navigation and disk writes.
  const adapter = dependencies.host;
  const MODES = {
    plain: ['纯文本', null], markdown: ['Markdown', 'text/x-markdown'],
    javascript: ['JavaScript', 'text/javascript'], json: ['JSON', 'application/json'],
    jsonc: ['JSON with comments', { name: 'javascript', json: true }],
    typescript: ['TypeScript', 'application/typescript'], jsx: ['JSX', 'text/jsx'],
    tsx: ['TSX', { name: 'jsx', base: { name: 'javascript', typescript: true } }],
    python: ['Python', 'text/x-python'], rust: ['Rust', 'text/x-rustsrc'],
    go: ['Go', 'text/x-go'], c: ['C', 'text/x-csrc'], cpp: ['C++', 'text/x-c++src'],
    java: ['Java', 'text/x-java'], csharp: ['C#', 'text/x-csharp'],
    css: ['CSS', 'text/css'], scss: ['SCSS', 'text/x-scss'],
    yaml: ['YAML', 'text/x-yaml'], toml: ['TOML', 'text/x-toml'],
    ini: ['INI / properties', 'text/x-properties'], shell: ['Shell', 'text/x-sh'],
    powershell: ['PowerShell', 'application/x-powershell'], sql: ['SQL', 'text/x-sql'],
    xml: ['XML (仅文本)', 'application/xml']
  };
  const EXTENSIONS = {
    txt: 'plain', log: 'plain', csv: 'plain', tsv: 'plain', env: 'ini',
    md: 'markdown', mdc: 'markdown', markdown: 'markdown', json: 'json', jsonc: 'jsonc',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', tsx: 'tsx', css: 'css', scss: 'scss',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
    properties: 'ini', py: 'python', pyw: 'python', rs: 'rust', go: 'go',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', hxx: 'cpp',
    java: 'java', cs: 'csharp', sh: 'shell', bash: 'shell', zsh: 'shell',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', sql: 'sql',
    bat: 'plain', cmd: 'plain', xml: 'xml'
  };
  if (!adapter && (location.protocol !== 'file:' || window.top !== window.self || location.pathname.endsWith('/'))) return false;
  const decode = value => { try { return decodeURIComponent(value); } catch (_) { return value; } };
  const url = new URL(adapter ? adapter.href : location.href);
  if (url.protocol !== 'file:') return false;
  url.search = '';
  url.hash = '';
  const filename = decode(url.pathname.split('/').pop() || '');
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!Object.hasOwn(EXTENSIONS, extension)) return false;
  const mime = adapter ? 'text/plain' : document.contentType.toLowerCase().split(';')[0].trim();
  if (/html|xml|svg/.test(mime) || (!mime.startsWith('text/') && !/^application\/(?:json|javascript|x-javascript|ecmascript|yaml|x-yaml|toml|sql|x-sh|x-powershell)$/.test(mime))) return false;
  const TOKEN = Symbol.for('directory-studio.text.startup');
  if (document[TOKEN] || document.getElementById('local-text-studio') || document.getElementById('local-text-studio-fallback')) return true;
  Object.defineProperty(document, TOKEN, { value: true, configurable: true });
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_LINES = 50000;
  let observer;
  let timer;
  let finished = false;
  function stop() {
    if (observer) observer.disconnect();
    clearTimeout(timer);
    document.removeEventListener('DOMContentLoaded', attempt);
    window.removeEventListener('pagehide', abandon);
  }
  function abandon() {
    if (finished) return;
    finished = true;
    stop();
    delete document[TOKEN];
  }
  function nativeText() {
    if (adapter) {
      const pre = document.createElement('pre');
      pre.textContent = adapter.text;
      return { pre, nativeNodes: [] };
    }
    return environment.nativeText(document, mime);
  }
  function attempt() {
    if (finished || document.readyState === 'loading') return;
    const native = nativeText();
    finished = true;
    stop();
    if (!native) { delete document[TOKEN]; return; }
    const { pre, nativeNodes } = native;
    const source = pre.textContent;
    let lines = 1;
    for (let index = 0; index < source.length && lines <= MAX_LINES; index++) {
      const char = source.charCodeAt(index);
      if (char === 10 || char === 13) lines++;
      if (char === 13 && source.charCodeAt(index + 1) === 10) index++;
    }
    if (source.length > MAX_BYTES || new Blob([source]).size > MAX_BYTES || lines > MAX_LINES) {
      const note = document.createElement('aside');
      note.id = 'local-text-studio-fallback';
      note.setAttribute('role', 'status');
      note.textContent = '文件超过 2 MiB 或 50,000 行，保留原始文本以避免编辑器卡顿。未修改文件。';
      note.style.cssText = 'position:fixed;bottom:14px;right:14px;max-width:calc(100vw - 28px);padding:12px 16px;background:#edf3fb;color:#182b49;border:1px solid #b7cae4;border-radius:8px;font:13px/1.6 "Segoe UI Variable","Microsoft YaHei",sans-serif;z-index:2147483646;';
      document.body.append(note);
      return;
    }
    try { mountText(pre, source, nativeNodes); } catch (error) { delete document[TOKEN]; if (adapter) throw error; }
  }

  function mountText(pre, source, nativeNodes) {
    const cleanup = [];
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-local-text-studio-theme');
    const previousNative = new Map(nativeNodes.map(node => [node, node.getAttribute('data-local-text-studio-native')]));
    const host = document.createElement('section');
    host.id = 'local-text-studio';
    host.setAttribute('aria-label', '本地文本编辑器');
    const style = document.createElement('style');
    style.id = 'local-text-studio-style';
    const documentStyle = document.createElement('style');
    documentStyle.id = 'local-text-studio-document-style';
    documentStyle.textContent = '[data-local-text-studio-native="hidden"]{display:none!important}' +
      'html[data-local-text-studio-theme="light"],html[data-local-text-studio-theme="light"] body{background:#edf3fb!important;color-scheme:light!important}' +
      'html[data-local-text-studio-theme="dark"],html[data-local-text-studio-theme="dark"] body{background:#111c2e!important;color-scheme:dark!important}' +
      'html[data-local-text-studio-theme="economist"],html[data-local-text-studio-theme="economist"] body{background:#f6f3ed!important;color-scheme:light!important}' +
      'html[data-local-text-studio-theme="vercel"],html[data-local-text-studio-theme="vercel"] body{background:#fff!important;color-scheme:light!important}';
    function restoreNative() {
      documentStyle.disabled = true;
      for (const [node, value] of previousNative) {
        if (value === null) node.removeAttribute('data-local-text-studio-native');
        else node.setAttribute('data-local-text-studio-native', value);
      }
      if (previousTheme === null) root.removeAttribute('data-local-text-studio-theme');
      else root.setAttribute('data-local-text-studio-theme', previousTheme);
    }
    const rollback = () => {
      cleanup.forEach(fn => fn());
      restoreNative();
      host.remove();
      style.remove();
      documentStyle.remove();
    };
    try {
      const { CodeMirror, MarkdownIt, createMermaidPreviewController, createMarkmapPreviewController, createStudioMarkdownRenderer, scheduleStudioDiagramRender } = dependencies;
      const memory = Object.create(null);
      const read = (key, fallback) => {
        try { if (typeof GM_getValue === 'function') return GM_getValue('directory-studio.' + key, fallback); } catch (_) { /* Optional storage. */ }
        return Object.hasOwn(memory, key) ? memory[key] : fallback;
      };
      const save = (key, value) => {
        memory[key] = value;
        try { if (typeof GM_setValue === 'function') GM_setValue('directory-studio.' + key, value); } catch (_) { /* Never store file contents. */ }
      };
      let theme = normalizeLocalTextStudioTheme(read('theme', 'light'));
      let wrap = read('editor.wrap', false) === true;
      let selectedMode = 'auto';
      let activeMode = EXTENSIONS[extension];
      let markdownView = window.matchMedia('(min-width:900px)').matches ? 'split' : 'edit';
      let original = false;
      let dirty = false;
      let noticeTimer;
      let previewTimer;
      let searchTimer;
      let refreshFrame;
      const objectURLs = new Set();
      const filesystemPath = value => value.hostname
        ? '\\\\' + value.hostname + decode(value.pathname).replaceAll('/', '\\')
        : /^\/[a-z]:\//i.test(value.pathname) ? decode(value.pathname).slice(1).replaceAll('/', '\\') : decode(value.pathname);
      const fullPath = filesystemPath(url);
      const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      const button = (text, title = text) => {
        const node = element('button', 'lts-button', text);
        node.type = 'button';
        node.title = title;
        node.setAttribute('aria-label', title);
        return node;
      };
      const anchor = (text, target, className = '') => {
        const node = element('a', className, text);
        node.href = target;
        return node;
      };
      style.textContent = dependencies.css + `
#local-text-studio{--bg:#edf3fb;--surface:#fbfdff;--card:#fff;--text:#182b49;--muted:#6c7e97;--line:#dbe5f1;--blue:#2563eb;--wash:#eaf1ff;--keyword:#3153bb;--string:#16776e;--number:#9b6517;--comment:#75849b;--tag:#a13e70;position:fixed;inset:0;z-index:1;height:100vh;height:100dvh;color:var(--text);background:radial-gradient(ellipse at 90% 0%,#8db7fa24,transparent 48%),var(--bg);font:13px/1.5 'Segoe UI Variable','Microsoft YaHei','Segoe UI',sans-serif;color-scheme:light;isolation:isolate}
#local-text-studio[data-theme=dark]{--bg:#111c2e;--surface:#17253a;--card:#1c2d44;--text:#e0eafb;--muted:#9bb0cc;--line:#30435d;--blue:#8cb4ff;--wash:#253b5d;--keyword:#9ebdff;--string:#83cfbb;--number:#e5b778;--comment:#95a5be;--tag:#e0a1c7;color-scheme:dark}
#local-text-studio[data-theme=economist]{--bg:#f6f3ed;--surface:#f6f3ed;--card:#fffdf8;--text:#262626;--muted:#68635c;--line:#d5d0c7;--blue:#e3120b;--wash:#f8e5df;--keyword:#a50e09;--string:#426549;--number:#86551e;--comment:#716b62;--tag:#8c3842;background:var(--bg);color-scheme:light}
#local-text-studio[data-theme=economist] .CodeMirror-focused .CodeMirror-selected,#local-text-studio[data-theme=economist] .CodeMirror-line::selection,#local-text-studio[data-theme=economist] .CodeMirror-line span::selection{background:#e3120b26}
#local-text-studio[data-theme=economist] .lts-preview a{color:#b6100a}
#local-text-studio[data-theme=vercel]{--bg:#fff;--surface:#fff;--card:#fafafa;--text:#171717;--muted:#666;--line:#eaeaea;--blue:#171717;--wash:#f2f2f2;background:var(--bg);color-scheme:light}
#local-text-studio[data-theme=vercel] .CodeMirror-focused .CodeMirror-selected,#local-text-studio[data-theme=vercel] .CodeMirror-line::selection,#local-text-studio[data-theme=vercel] .CodeMirror-line span::selection{background:#00000020}
#local-text-studio .lts-app{height:100%;display:flex;flex-direction:column;min-height:0}#local-text-studio .lts-header,#local-text-studio .lts-heading,#local-text-studio .lts-toolbar,#local-text-studio .lts-status{box-sizing:border-box}#local-text-studio button,#local-text-studio input,#local-text-studio select{font:inherit}#local-text-studio a{color:inherit;text-decoration:none}#local-text-studio button{cursor:pointer;color:inherit}#local-text-studio button:disabled{opacity:.4;cursor:default}#local-text-studio button:focus-visible,#local-text-studio a:focus-visible,#local-text-studio input:focus-visible,#local-text-studio select:focus-visible{outline:3px solid var(--blue);outline-offset:2px}#local-text-studio [hidden]{display:none!important}
#local-text-studio .lts-header{height:58px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 24px;border-bottom:1px solid var(--line)}#local-text-studio .lts-brand{font:600 15px Bahnschrift,'Microsoft YaHei',sans-serif;letter-spacing:1.8px;white-space:nowrap}#local-text-studio .lts-brand:before{content:'';display:inline-block;width:8px;height:18px;background:var(--blue);border-radius:3px;margin-right:10px;vertical-align:-3px}#local-text-studio .lts-header-actions{display:flex;align-items:center;gap:7px}#local-text-studio .lts-local{font-size:11px;color:var(--muted);margin-right:9px}#local-text-studio .lts-button{border:1px solid var(--line);border-radius:7px;padding:7px 10px;min-height:34px;background:var(--card);white-space:nowrap;box-sizing:border-box}#local-text-studio .lts-button:hover:not(:disabled){background:var(--wash);border-color:var(--blue)}#local-text-studio .lts-button[aria-pressed=true]{background:var(--wash);color:var(--blue);border-color:var(--blue)}#local-text-studio .lts-primary{background:var(--blue);border-color:var(--blue);color:var(--card)}
#local-text-studio .lts-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 24px 13px;flex-shrink:0}#local-text-studio .lts-path{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;font:14px/1.7 Consolas,'Microsoft YaHei',monospace;color:var(--muted);overflow-wrap:anywhere}#local-text-studio .lts-path a{padding:2px 5px;border-radius:5px;max-width:100%;min-width:0;overflow-wrap:anywhere}#local-text-studio .lts-path a:hover{color:var(--blue);background:var(--wash)}#local-text-studio .lts-path [aria-current=page]{font:600 20px/1.5 Bahnschrift,'Microsoft YaHei',sans-serif;color:var(--blue);background:var(--wash);border:1px solid var(--line);border-radius:8px;padding:4px 10px;max-width:100%;min-width:0;overflow-wrap:anywhere}#local-text-studio .lts-separator{color:var(--muted);opacity:.7;padding:0 2px}#local-text-studio .lts-parent{flex-shrink:0}
#local-text-studio .lts-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 24px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);flex-shrink:0}#local-text-studio .lts-search{display:flex;align-items:center;gap:4px;min-width:0;flex:1;max-width:510px}#local-text-studio .lts-search input{min-width:80px;width:100%;height:34px;box-sizing:border-box;border:1px solid var(--line);border-radius:7px;padding:0 10px;background:var(--card);color:var(--text)}#local-text-studio .lts-search .lts-button{padding:6px 8px}#local-text-studio .lts-matches{white-space:nowrap;color:var(--muted);font-size:11px;min-width:52px;text-align:center}#local-text-studio .lts-mode{max-width:172px;height:34px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--text);padding:0 7px;box-sizing:border-box}#local-text-studio .lts-actions,#local-text-studio .lts-views{display:flex;align-items:center;gap:5px}#local-text-studio .lts-actions{margin-left:auto}#local-text-studio .lts-views{padding-left:7px;border-left:1px solid var(--line)}
#local-text-studio .lts-panes{display:grid;grid-template-columns:minmax(0,1fr);flex:1;min-height:0;overflow:hidden;background:var(--surface)}#local-text-studio .lts-panes[data-layout=split]{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#local-text-studio .lts-editor{min-height:0;min-width:0;overflow:hidden}#local-text-studio .CodeMirror{height:100%;font:13px/1.7 Consolas,'Microsoft YaHei',monospace;background:var(--surface);color:var(--text)}#local-text-studio .CodeMirror-lines{padding:14px 0}#local-text-studio .CodeMirror pre.CodeMirror-line,#local-text-studio .CodeMirror pre.CodeMirror-line-like{padding:0 14px}#local-text-studio .CodeMirror-gutters{background:var(--bg);border-color:var(--line)}#local-text-studio .CodeMirror-linenumber{color:var(--muted);padding-left:9px;padding-right:12px}#local-text-studio .CodeMirror-cursor{border-left-color:var(--text)}#local-text-studio .CodeMirror-selected{background:var(--wash)}#local-text-studio .CodeMirror-focused .CodeMirror-selected{background:#5595ff40}#local-text-studio .CodeMirror-line::selection,#local-text-studio .CodeMirror-line span::selection{background:#5595ff40}#local-text-studio .CodeMirror-scrollbar-filler,#local-text-studio .CodeMirror-gutter-filler{background:var(--surface)}#local-text-studio .cm-s-localstudio .cm-keyword,#local-text-studio .cm-s-localstudio .cm-atom,#local-text-studio .cm-s-localstudio .cm-def,#local-text-studio .cm-s-localstudio .cm-builtin{color:var(--keyword)}#local-text-studio .cm-s-localstudio .cm-string,#local-text-studio .cm-s-localstudio .cm-string-2{color:var(--string)}#local-text-studio .cm-s-localstudio .cm-number{color:var(--number)}#local-text-studio .cm-s-localstudio .cm-comment,#local-text-studio .cm-s-localstudio .cm-meta{color:var(--comment)}#local-text-studio .cm-s-localstudio .cm-variable-2,#local-text-studio .cm-s-localstudio .cm-variable-3,#local-text-studio .cm-s-localstudio .cm-type,#local-text-studio .cm-s-localstudio .cm-property{color:var(--string)}#local-text-studio .cm-s-localstudio .cm-tag,#local-text-studio .cm-s-localstudio .cm-attribute{color:var(--tag)}#local-text-studio .cm-s-localstudio .cm-header,#local-text-studio .cm-s-localstudio .cm-link{color:var(--blue)}#local-text-studio .cm-s-localstudio .cm-error{color:#d14c54}#local-text-studio .CodeMirror-matchingbracket{color:var(--string);background:var(--wash)}
#local-text-studio .lts-preview{box-sizing:border-box;min-width:0;min-height:0;overflow:auto;padding:24px 28px;background:var(--card);line-height:1.85;overflow-wrap:anywhere}#local-text-studio .lts-panes[data-layout=split] .lts-preview{border-left:1px solid var(--line)}#local-text-studio .lts-preview>:first-child{margin-top:0}#local-text-studio .lts-preview h1,#local-text-studio .lts-preview h2,#local-text-studio .lts-preview h3{font-family:Bahnschrift,'Microsoft YaHei',sans-serif;line-height:1.4;margin:1.3em 0 .5em}#local-text-studio .lts-preview h1{font-size:27px}#local-text-studio .lts-preview h2{font-size:22px;border-bottom:1px solid var(--line);padding-bottom:7px}#local-text-studio .lts-preview h3{font-size:18px}#local-text-studio .lts-preview pre{margin:14px 0;padding:15px;background:var(--bg);border:1px solid var(--line);border-radius:8px;overflow:auto;white-space:pre}#local-text-studio .lts-preview code{font:12px/1.7 Consolas,'Microsoft YaHei',monospace;background:var(--bg);padding:2px 4px;border-radius:3px}#local-text-studio .lts-preview pre code{padding:0;background:none}#local-text-studio .lts-preview a{color:var(--blue);text-decoration:underline;text-underline-offset:3px}#local-text-studio .lts-preview blockquote{margin:14px 0;border-left:3px solid var(--blue);padding:2px 16px;color:var(--muted)}#local-text-studio .lts-preview table{border-collapse:collapse;display:block;overflow:auto;font-size:12px}#local-text-studio .lts-preview td,#local-text-studio .lts-preview th{border:1px solid var(--line);padding:7px 11px}#local-text-studio .lts-preview hr{border:0;border-top:1px solid var(--line);margin:22px 0}#local-text-studio .lts-image-label{display:inline-block;border:1px dashed var(--line);border-radius:5px;padding:3px 8px;color:var(--muted);font-size:12px}
#local-text-studio .lts-status{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 14px;padding:7px 24px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);flex-shrink:0}#local-text-studio .lts-dirty[data-dirty=true]{color:var(--blue);font-weight:600}#local-text-studio .lts-cursor{font-family:Consolas,monospace}#local-text-studio .lts-notice{position:absolute;bottom:43px;left:50%;transform:translateX(-50%);max-width:calc(100% - 40px);box-sizing:border-box;background:var(--text);color:var(--card);border-radius:8px;padding:10px 16px;box-shadow:0 6px 24px #12223a20;font-size:12px;z-index:6;overflow-wrap:anywhere}#local-text-studio .lts-notice:empty{display:none}#local-text-studio[data-original=true]{inset:auto 18px 18px auto;height:auto;background:transparent;z-index:2147483646}#local-text-studio .lts-restore{box-shadow:0 4px 24px #10244330;border-color:var(--blue)}
#local-text-studio .lts-mermaid-card{border:1px solid var(--line);border-radius:9px;padding:14px;margin:16px 0;background:var(--surface);min-width:0}#local-text-studio .lts-mermaid-label{font:600 10px Bahnschrift,Consolas,monospace;letter-spacing:1.4px;color:var(--blue)}#local-text-studio .lts-mermaid-status{margin:5px 0 10px;font-size:11px;color:var(--muted)}#local-text-studio .lts-mermaid-card[data-state=error] .lts-mermaid-status{color:var(--tag)}#local-text-studio .lts-mermaid-surface{overflow:visible;min-width:0}#local-text-studio .lts-mermaid-image{display:block;max-width:100%;height:auto;margin:0 auto}#local-text-studio .lts-mermaid-source{font-size:11px;color:var(--muted);margin-top:12px}#local-text-studio .lts-mermaid-source summary{cursor:pointer;padding:3px 0}#local-text-studio .lts-mermaid-source summary:focus-visible{outline:3px solid var(--blue);outline-offset:2px}#local-text-studio .lts-mermaid-source pre{color:var(--text)}
#local-text-studio .lts-mermaid-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}#local-text-studio .lts-mermaid-height{font-size:11px;min-height:28px;padding:4px 8px}#local-text-studio .lts-mermaid-surface[data-height="fixed"]{max-height:640px;overflow:auto}
#local-text-studio .lts-markmap-card{border:1px solid var(--line);border-radius:9px;padding:14px;margin:16px 0;background:var(--surface);min-width:0}#local-text-studio .lts-markmap-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}#local-text-studio .lts-markmap-label{font:600 10px Bahnschrift,Consolas,monospace;letter-spacing:1.4px;color:var(--blue)}#local-text-studio .lts-markmap-controls{display:flex;gap:5px;flex-wrap:wrap}#local-text-studio .lts-markmap-controls .lts-button{font-size:11px;min-height:28px;padding:4px 8px}#local-text-studio .lts-markmap-status{margin:5px 0 10px;font-size:11px;color:var(--muted)}#local-text-studio .lts-markmap-card[data-state=error] .lts-markmap-status{color:var(--tag)}#local-text-studio .lts-markmap-frame{display:block;width:100%;height:clamp(280px,48vh,520px);border:0;border-radius:5px;background:var(--surface)}#local-text-studio .lts-markmap-source{font-size:11px;color:var(--muted);margin-top:12px}#local-text-studio .lts-markmap-source summary{cursor:pointer;padding:3px 0}#local-text-studio .lts-markmap-source pre{max-height:280px;overflow:auto;white-space:pre-wrap}
@media(max-width:1000px){#local-text-studio .lts-search{max-width:none;flex-basis:45%}#local-text-studio .lts-actions{margin-left:0}#local-text-studio .lts-local{display:none}}
@media(max-width:700px){#local-text-studio .lts-header{height:52px;padding:0 12px;gap:7px}#local-text-studio .lts-brand{font-size:11px;letter-spacing:1px}#local-text-studio .lts-header-actions{gap:4px}#local-text-studio .lts-button{font-size:11px;padding:6px 8px;min-height:32px}#local-text-studio .lts-heading{padding:12px;gap:7px;align-items:flex-start}#local-text-studio .lts-path{font-size:12px;gap:2px}#local-text-studio .lts-path [aria-current=page]{font-size:18px;padding:3px 7px}#local-text-studio .lts-parent{margin-top:3px}#local-text-studio .lts-toolbar{padding:8px 12px;gap:6px}#local-text-studio .lts-search{flex-basis:100%;width:100%}#local-text-studio .lts-matches{font-size:10px;min-width:48px}#local-text-studio .lts-mode{font-size:11px;max-width:150px;flex:1}#local-text-studio .lts-actions{gap:4px;flex-wrap:wrap}#local-text-studio .lts-views{gap:3px;padding-left:5px}#local-text-studio .lts-panes[data-layout=split]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)}#local-text-studio .lts-panes[data-layout=split] .lts-preview{border-left:0;border-top:1px solid var(--line)}#local-text-studio .lts-preview{padding:18px}#local-text-studio .lts-status{padding:7px 12px;font-size:10px}#local-text-studio .lts-encoding{display:none}#local-text-studio .CodeMirror{font-size:12px}}
@media(prefers-reduced-motion:reduce){#local-text-studio *,#local-text-studio *:before,#local-text-studio *:after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
#local-text-studio .lts-primary:hover:not(:disabled){background:var(--blue);color:var(--card);filter:brightness(.95)}
`;
      const app = element('div', 'lts-app');
      const header = element('header', 'lts-header');
      const headerActions = element('div', 'lts-header-actions');
      const themeButton = button('深色', '切换深色主题');
      const originalButton = button('原始文本');
      if (adapter) originalButton.hidden = true;
      headerActions.append(element('span', 'lts-local', '离线编辑 · 不改写原文件'), themeButton, originalButton);
      header.append(element('span', 'lts-brand', 'DIRECTORY STUDIO / TEXT'), headerActions);
      const heading = element('div', 'lts-heading');
      const breadcrumb = element('nav', 'lts-path');
      breadcrumb.setAttribute('aria-label', '文件路径');
      breadcrumb.title = fullPath;
      const parts = url.pathname.split('/').filter(Boolean);
      const drive = /^[a-z]:$/i.test(decode(parts[0] || ''));
      const rootDepth = drive || url.hostname ? Math.min(1, parts.length - 1) : 0;
      const rootURL = new URL(url.href);
      rootURL.pathname = rootDepth ? '/' + parts[0] + '/' : '/';
      const rootCrumb = anchor(drive ? decode(parts[0]) + '\\' : url.hostname ? '\\\\' + url.hostname + (rootDepth ? '\\' + decode(parts[0]) : '') : '/', rootURL.href);
      rootCrumb.title = filesystemPath(rootURL);
      breadcrumb.append(rootCrumb);
      for (let index = rootDepth; index < parts.length - 1; index++) {
        const partURL = new URL(url.href);
        partURL.pathname = '/' + parts.slice(0, index + 1).join('/') + '/';
        const crumb = anchor(decode(parts[index]), partURL.href);
        crumb.title = filesystemPath(partURL);
        const separator = element('span', 'lts-separator', '/');
        separator.setAttribute('aria-hidden', 'true');
        breadcrumb.append(separator, crumb);
      }
      const currentSeparator = element('span', 'lts-separator', '/');
      currentSeparator.setAttribute('aria-hidden', 'true');
      const current = element('span', '', filename);
      current.setAttribute('aria-current', 'page');
      current.title = fullPath;
      breadcrumb.append(currentSeparator, current);
      const parent = anchor('上级目录', new URL('./', url).href, 'lts-button lts-parent');
      parent.setAttribute('aria-label', '打开上级目录');
      heading.append(breadcrumb, parent);
      const toolbar = element('section', 'lts-toolbar');
      toolbar.setAttribute('aria-label', '文本编辑工具栏');
      const searchGroup = element('div', 'lts-search');
      const search = element('input');
      search.type = 'search';
      search.placeholder = '查找文本 · Ctrl+F';
      search.setAttribute('aria-label', '查找文本');
      search.autocomplete = 'off';
      search.spellcheck = false;
      const previous = button('上一处', '上一个匹配');
      const next = button('下一处', '下一个匹配');
      const matches = element('span', 'lts-matches', '0 个匹配');
      matches.setAttribute('role', 'status');
      matches.setAttribute('aria-live', 'polite');
      searchGroup.append(search, previous, next, matches);
      const mode = element('select', 'lts-mode');
      mode.setAttribute('aria-label', '语法模式');
      const auto = element('option', '', '自动 · ' + MODES[activeMode][0]);
      auto.value = 'auto';
      mode.append(auto);
      for (const [key, [label]] of Object.entries(MODES)) {
        const option = element('option', '', label);
        option.value = key;
        mode.append(option);
      }
      const wrapButton = button('自动换行');
      wrapButton.setAttribute('aria-pressed', String(wrap));
      const undo = button('撤销');
      const redo = button('重做');
      const format = button('JSON 格式化');
      const copyText = button('复制全文');
      copyText.title = '复制当前编辑内容（含未保存修改）';
      const download = button('下载编辑副本', '下载编辑副本 (Ctrl+S)');
      download.classList.add('lts-primary');
      const saveOriginal = adapter ? button('保存原文件', '授权后保存原文件 (Ctrl+S)') : null;
      if (saveOriginal) { download.title = '下载 UTF-8 编辑副本'; download.setAttribute('aria-label', '下载编辑副本'); }
      const actions = element('div', 'lts-actions');
      actions.append(wrapButton, undo, redo, format);
      const views = element('div', 'lts-views');
      views.setAttribute('role', 'group');
      views.setAttribute('aria-label', 'Markdown 显示方式');
      const viewButtons = {};
      for (const [key, label] of [['edit', '编辑'], ['preview', '预览'], ['split', '分栏']]) {
        const control = button(label);
        control.addEventListener('click', () => { markdownView = key; applyLayout(); });
        viewButtons[key] = control;
        views.append(control);
      }
      toolbar.append(searchGroup, mode, actions, views, copyText, download);
      if (saveOriginal) toolbar.append(saveOriginal);
      const panes = element('div', 'lts-panes');
      const editorPane = element('div', 'lts-editor');
      const preview = element('article', 'lts-preview');
      preview.setAttribute('aria-label', 'Markdown 预览');
      panes.append(editorPane, preview);
      const status = element('footer', 'lts-status');
      const dirtyLabel = element('span', 'lts-dirty', '未修改');
      dirtyLabel.setAttribute('role', 'status');
      dirtyLabel.setAttribute('aria-live', 'polite');
      const cursorLabel = element('span', 'lts-cursor');
      const encoding = element('span', 'lts-encoding', '下载为 UTF-8 · 不保留原始字节编码');
      encoding.title = '源文本取自 Chrome 解码后的 PRE；下载不会覆盖原文件，换行可能归一化为 LF。';
      if (adapter) { encoding.textContent = 'UTF-8 · 原位保存需授权'; encoding.title = '读取原始 UTF-8 字节；保存保留 BOM 和一致的换行符，检测外部修改。'; }
      status.append(dirtyLabel, cursorLabel, encoding);
      const notice = element('div', 'lts-notice');
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      const restore = button('返回编辑器');
      restore.classList.add('lts-restore');
      restore.hidden = true;
      app.append(header, heading, toolbar, panes, status);
      host.append(app, restore, notice);
      host.dataset.theme = theme;
      document.head.append(style, documentStyle);
      (adapter ? adapter.mount : document.body).append(host);
      const cm = CodeMirror(editorPane, {
        value: source, mode: MODES[activeMode][1], theme: 'localstudio', lineNumbers: true,
        lineWrapping: wrap, indentUnit: 2, tabSize: 2, smartIndent: true,
        matchBrackets: true, viewportMargin: 10,
        extraKeys: {
          Tab: instance => instance.somethingSelected() ? instance.indentSelection('add') : instance.replaceSelection('  ', 'end', '+input'),
          'Shift-Tab': 'indentLess'
        }
      });
      cm.getInputField().setAttribute('aria-label', '文本编辑器');
      cm.getInputField().spellcheck = false;
      cm.clearHistory();
      let baseline = cm.getValue();
      let saving = false;
      let disposed = false;
      const markdown = createStudioMarkdownRenderer(MarkdownIt, url);
      const mermaidPreview = createMermaidPreviewController(host, preview);
      const markmapPreview = createMarkmapPreviewController(host, preview);
      let previewGeneration = 0;
      let cancelDiagrams = () => {};
      function invalidatePreview() {
        previewGeneration++; cancelDiagrams(); mermaidPreview.invalidate(); markmapPreview.invalidate();
      }
      cleanup.push(() => { cancelDiagrams(); mermaidPreview.dispose(); markmapPreview.dispose(); });
      function announce(message) {
        clearTimeout(noticeTimer);
        notice.textContent = message;
        noticeTimer = setTimeout(() => { notice.textContent = ''; }, 5000);
      }
      function applyTheme() {
        host.dataset.theme = theme;
        themeButton.textContent = theme === 'light' ? '深色' : '浅色';
        const label = theme === 'light' ? '切换深色主题' : '切换浅色主题';
        themeButton.title = label;
        themeButton.setAttribute('aria-label', label);
        if (!original) {
          root.setAttribute('data-local-text-studio-theme', theme);
          nativeNodes.forEach(node => node.setAttribute('data-local-text-studio-native', 'hidden'));
          documentStyle.disabled = false;
        }
      }
      function updateStatus() {
        dirty = cm.getValue() !== baseline;
        dirtyLabel.textContent = dirty ? '已修改（仅页面）' : '未修改';
        dirtyLabel.dataset.dirty = String(dirty);
        const position = cm.getCursor();
        cursorLabel.textContent = '行 ' + (position.line + 1) + '，列 ' + (position.ch + 1) + ' · ' + cm.lineCount() + ' 行';
        const history = cm.historySize();
        undo.disabled = !history.undo;
        redo.disabled = !history.redo;
      }
      function renderPreview() {
        clearTimeout(previewTimer);
        invalidatePreview();
        if (original || activeMode !== 'markdown' || markdownView === 'edit') return;
        const text = cm.getValue();
        if (text.length > 512 * 1024 || new Blob([text]).size > 512 * 1024) {
          preview.textContent = 'Markdown 超过 512 KiB，暂停预览以保持编辑流畅。内容仍可编辑和下载。';
          return;
        }
        try {
          const rendered = markdown.render(text);
          // Only the shared escaped, resource-free renderer may produce preview HTML.
          preview.innerHTML = rendered.html;
          const generation = previewGeneration;
          // Diagram sandboxes retain their existing light/dark protocol.
          const diagramTheme = theme === 'dark' ? 'dark' : 'light';
          if (rendered.blocks.length || rendered.markmapBlocks.length) cancelDiagrams = scheduleStudioDiagramRender(() => {
            if (generation === previewGeneration && !original && activeMode === 'markdown' && markdownView !== 'edit') {
              mermaidPreview.render(rendered.blocks, diagramTheme, () => generation === previewGeneration && !original && activeMode === 'markdown' && markdownView !== 'edit').catch(() => {});
              if (rendered.markmapBlocks.length) markmapPreview.render(rendered.markmapBlocks, diagramTheme, () => generation === previewGeneration && !original && activeMode === 'markdown' && markdownView !== 'edit').catch(() => {});
            }
          });
        } catch (_) { preview.textContent = '预览失败。原始编辑内容未改动，可继续编辑或下载副本。'; }
      }
      function applyLayout() {
        const isMarkdown = activeMode === 'markdown';
        const layout = isMarkdown ? markdownView : 'edit';
        panes.dataset.layout = layout;
        editorPane.hidden = layout === 'preview';
        preview.hidden = layout === 'edit';
        views.hidden = !isMarkdown;
        format.hidden = activeMode !== 'json';
        for (const [key, control] of Object.entries(viewButtons)) control.setAttribute('aria-pressed', String(key === layout));
        renderPreview();
        cancelAnimationFrame(refreshFrame);
        refreshFrame = requestAnimationFrame(() => { if (host.isConnected && !original) cm.refresh(); });
      }
      function countMatches() {
        clearTimeout(searchTimer);
        const query = search.value;
        let count = 0;
        let capped = false;
        if (query) {
          const cursor = cm.getSearchCursor(query, CodeMirror.Pos(0, 0), { caseFold: true });
          while (cursor.findNext()) {
            count++;
            if (count === 10000) { capped = cursor.findNext(); break; }
          }
        }
        matches.textContent = String(count) + (capped ? '+' : '') + ' 个匹配';
        previous.disabled = next.disabled = !count;
      }
      function findMatch(reverse = false, fromStart = false) {
        if (!search.value) return;
        const end = CodeMirror.Pos(cm.lastLine(), cm.getLine(cm.lastLine()).length);
        let cursor = cm.getSearchCursor(search.value, fromStart ? CodeMirror.Pos(0, 0) : cm.getCursor(reverse ? 'from' : 'to'), { caseFold: true });
        if (!cursor.find(reverse)) {
          cursor = cm.getSearchCursor(search.value, reverse ? end : CodeMirror.Pos(0, 0), { caseFold: true });
          if (!cursor.find(reverse)) return;
        }
        cm.setSelection(cursor.from(), cursor.to());
        cm.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 60);
      }
      function exportCopy() {
        let objectURL;
        try {
          const dot = filename.lastIndexOf('.');
          const proposed = dot > 0 ? filename.slice(0, dot) + '.edited' + filename.slice(dot) : filename + '.edited.txt';
          const downloadName = proposed.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
          objectURL = URL.createObjectURL(new Blob([cm.getValue()], { type: 'text/plain;charset=utf-8' }));
          objectURLs.add(objectURL);
          const downloadLink = anchor('', objectURL);
          downloadLink.download = downloadName;
          downloadLink.hidden = true;
          host.append(downloadLink);
          try { downloadLink.click(); } finally { downloadLink.remove(); }
          const revokeTimer = setTimeout(() => { URL.revokeObjectURL(objectURL); objectURLs.delete(objectURL); }, 30000);
          cleanup.push(() => clearTimeout(revokeTimer));
          announce('已发起下载编辑副本；原文件未改动。');
        } catch (_) {
          if (objectURL) { URL.revokeObjectURL(objectURL); objectURLs.delete(objectURL); }
          announce('无法下载副本。可在编辑器中选择并复制文本。');
        }
      }
      async function persistOriginal() {
        if (!adapter || saving || disposed) return;
        const snapshot = cm.getValue();
        saving = true; saveOriginal.disabled = true;
        try {
          await adapter.save(snapshot);
          if (disposed) return;
          baseline = snapshot; updateStatus();
          announce(dirty ? '已保存提交时的内容；之后的修改仍未保存。' : '已保存原文件。');
        } catch (error) {
          if (!disposed) announce(error?.name === 'AbortError' ? '已取消授权，编辑内容保留。' : String(error?.message || '保存失败，编辑内容保留。'));
        } finally { saving = false; if (!disposed) saveOriginal.disabled = false; }
      }
      function setOriginal(value) {
        original = value;
        if (value) invalidatePreview();
        host.dataset.original = String(value);
        app.hidden = value;
        restore.hidden = !value;
        notice.textContent = '';
        if (value) { restoreNative(); restore.focus(); }
        else { applyTheme(); applyLayout(); if (!editorPane.hidden) cm.focus(); else originalButton.focus(); }
      }
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { countMatches(); findMatch(false, true); }, 160);
      });
      search.addEventListener('keydown', event => {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter') { event.preventDefault(); countMatches(); findMatch(event.shiftKey); }
        else if (event.key === 'Escape') {
          event.preventDefault();
          if (editorPane.hidden) { markdownView = 'edit'; applyLayout(); }
          cm.focus();
        }
      });
      previous.addEventListener('click', () => findMatch(true));
      next.addEventListener('click', () => findMatch(false));
      mode.addEventListener('change', () => {
        selectedMode = mode.value;
        activeMode = selectedMode === 'auto' ? EXTENSIONS[extension] : selectedMode;
        cm.setOption('mode', MODES[activeMode][1]);
        applyLayout();
      });
      wrapButton.addEventListener('click', () => {
        wrap = !wrap;
        cm.setOption('lineWrapping', wrap);
        wrapButton.setAttribute('aria-pressed', String(wrap));
        save('editor.wrap', wrap);
      });
      themeButton.addEventListener('click', () => { theme = theme === 'light' ? 'dark' : 'light'; save('theme', theme); applyTheme(); renderPreview(); });
      undo.addEventListener('click', () => { cm.undo(); cm.focus(); });
      redo.addEventListener('click', () => { cm.redo(); cm.focus(); });
      format.addEventListener('click', () => {
        try {
          const value = cm.getValue();
          const formatted = formatLocalJSON(value);
          if (formatted !== value) cm.replaceRange(formatted, CodeMirror.Pos(0, 0), CodeMirror.Pos(cm.lastLine(), cm.getLine(cm.lastLine()).length), '+format');
          announce('JSON 已格式化；仅修改页面中的编辑内容。');
        } catch (error) {
          announce(error instanceof SyntaxError ? 'JSON 无效，未修改任何内容。请检查语法后重试。' : 'JSON 过大或嵌套过深，未格式化；编辑内容保持不变。');
        }
      });
      copyText.addEventListener('click', async () => {
        copyText.disabled = true;
        try {
          const text = cm.getValue();
          if (typeof GM_setClipboard === 'function') await GM_setClipboard(text, 'text');
          else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') await navigator.clipboard.writeText(text);
          else throw new Error('Clipboard unavailable');
          announce('已复制当前编辑内容');
        } catch (_) {
          announce('复制失败。可在编辑器中全选后手动复制。');
        } finally {
          copyText.disabled = false;
        }
      });
      download.addEventListener('click', exportCopy);
      if (saveOriginal) saveOriginal.addEventListener('click', persistOriginal);
      originalButton.addEventListener('click', () => setOriginal(true));
      restore.addEventListener('click', () => setOriginal(false));
      cm.on('change', () => {
        updateStatus();
        invalidatePreview();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(countMatches, 160);
        clearTimeout(previewTimer);
        if (activeMode === 'markdown' && markdownView !== 'edit') previewTimer = setTimeout(renderPreview, 220);
      });
      cm.on('cursorActivity', updateStatus);
      const onBeforeUnload = event => {
        if (!dirty && !saving) return;
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      cleanup.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
      host.addEventListener('keydown', event => {
        if (original || event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === 's' || key === 'f') {
          event.preventDefault();
          event.stopPropagation();
          if (key === 's') { if (adapter) void persistOriginal(); else exportCopy(); }
          else { search.focus(); search.select(); }
        }
      }, true);
      const onPageHide = () => {
        invalidatePreview();
        clearTimeout(noticeTimer);
        clearTimeout(previewTimer);
        clearTimeout(searchTimer);
        cancelAnimationFrame(refreshFrame);
        objectURLs.forEach(value => URL.revokeObjectURL(value));
        objectURLs.clear();
      };
      window.addEventListener('pagehide', onPageHide);
      cleanup.push(() => { window.removeEventListener('pagehide', onPageHide); onPageHide(); });
      const onPageShow = event => { if (event.persisted && !original) renderPreview(); };
      window.addEventListener('pageshow', onPageShow);
      cleanup.push(() => window.removeEventListener('pageshow', onPageShow));
      applyTheme();
      applyLayout();
      countMatches();
      updateStatus();
      if (adapter) adapter.ready({
        getValue: () => cm.getValue(), isDirty: () => cm.getValue() !== baseline,
        isSaving: () => saving,
        setTheme(value) { theme = normalizeLocalTextStudioTheme(value); applyTheme(); renderPreview(); },
        dispose() { if (disposed) return; disposed = true; rollback(); delete document[TOKEN]; }
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }
  observer = new MutationObserver(attempt);
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', attempt, { once: true });
  window.addEventListener('pagehide', abandon, { once: true });
  timer = setTimeout(abandon, 5000);
  attempt();
  return true;
}

function formatLocalJSON(source) {
  // Validate first, then format tokens without rounding numbers or dropping duplicate keys.
  if (source.length > 2 * 1024 * 1024) throw new RangeError('JSON formatting input limit');
  JSON.parse(source);
  let output = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let previous = '';
  const indent = () => '  '.repeat(depth);
  for (let index = 0; index < source.length; index++) {
    if (output.length > 8 * 1024 * 1024) throw new RangeError('JSON formatting output limit');
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { inString = false; previous = '"'; }
      continue;
    }
    if (/\s/.test(char)) continue;
    if (char === '"') { inString = true; output += char; previous = char; continue; }
    if (char === '{' || char === '[') {
      output += char;
      depth++;
      if (depth > 128) throw new RangeError('JSON formatting nesting limit');
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (source[next] !== '}' && source[next] !== ']') output += '\n' + indent();
    } else if (char === '}' || char === ']') {
      depth--;
      if (previous !== '{' && previous !== '[') output += '\n' + indent();
      output += char;
    } else if (char === ',') output += ',\n' + indent();
    else if (char === ':') output += ': ';
    else output += char;
    previous = char;
  }
  return output;
}
