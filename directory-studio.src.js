// ==UserScript==
// @name         Directory Studio - 本地目录与文本编辑
// @namespace    local.directory-studio
// @version      1.6.1
// @description  本地目录浏览、图片查看、离线代码编辑与 Markdown/Mermaid/Markmap 预览；不上传、不自动覆盖原文件。
// @homepageURL  https://github.com/wuyixiang9/directory-studio
// @supportURL   https://github.com/wuyixiang9/directory-studio/issues
// @downloadURL  https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/directory-studio.user.js
// @updateURL    https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/directory-studio.meta.js
// @match        file:///*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_getResourceText
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @sandbox      DOM
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (location.protocol !== 'file:' || window.top !== window.self) return;
  if (startLocalTextStudio()) return;
  const MARKER = 'directory-studio-root';
  if (document.getElementById(MARKER)) return;
  const STARTUP = Symbol.for('directory-studio.startup');
  if (document[STARTUP]) return;
  Object.defineProperty(document, STARTUP, { value: true, configurable: true });
  let guard = null;
  let startupObserver;
  let startupTimer;
  let guardTimer;
  let settled = false;

  function cleanupStartup() {
    if (startupObserver) startupObserver.disconnect();
    clearTimeout(startupTimer);
    clearTimeout(guardTimer);
    document.removeEventListener('DOMContentLoaded', boot);
    window.removeEventListener('pagehide', failOpen);
  }
  function failOpen() {
    if (settled) return;
    settled = true;
    cleanupStartup();
    if (guard) guard.dispose();
    delete document[STARTUP];
  }

  function prepareGuard(native) {
    const nodes = [native.header, document.getElementById('parentDirLinkBox'), native.table];
    const originals = new Map(nodes.map(node => [node, node.getAttribute('data-directory-studio-native')]));
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-directory-studio-theme');
    const style = document.createElement('style');
    style.id = 'directory-studio-document-style';
    style.textContent = '[data-directory-studio-native="hidden"]{display:none!important}' +
      'html[data-directory-studio-theme="light"],html[data-directory-studio-theme="light"] body{background:#edf3fb!important;color-scheme:light!important}' +
      'html[data-directory-studio-theme="dark"],html[data-directory-studio-theme="dark"] body{background:#111c2e!important;color-scheme:dark!important}';
    guard = {
      host: null,
      cleanup: [],
      restore() {
        style.disabled = true;
        for (const [node, value] of originals) {
          if (value === null) node.removeAttribute('data-directory-studio-native');
          else node.setAttribute('data-directory-studio-native', value);
        }
        if (previousTheme === null) root.removeAttribute('data-directory-studio-theme');
        else root.setAttribute('data-directory-studio-theme', previousTheme);
      },
      apply(theme) {
        nodes.forEach(node => node.setAttribute('data-directory-studio-native', 'hidden'));
        root.setAttribute('data-directory-studio-theme', theme);
        style.disabled = false;
      },
      dispose() {
        this.restore();
        style.remove();
        if (this.host) this.host.remove();
        this.cleanup.forEach(cleanup => cleanup());
      }
    };
    document.head.append(style);
    style.disabled = true;
  }

  // Chrome emits this specific skeleton even when a directory has no entries.
  function nativeDirectory() {
    if (!location.pathname.endsWith('/')) return null;
    const body = document.getElementById('tbody');
    const header = document.getElementById('header');
    const parent = document.getElementById('parentDirLink');
    const table = body && body.closest('table');
    if (!body || body.tagName !== 'TBODY' || !header || header.tagName !== 'H1' ||
        !parent || parent.tagName !== 'A' || !table) return null;
    if (!['nameColumnHeader', 'sizeColumnHeader', 'dateColumnHeader'].every(id => {
      const item = document.getElementById(id);
      return item && item.tagName === 'TH' && table.contains(item);
    })) return null;
    if (![...document.scripts].some(script => /\bfunction\s+addRow\s*\(\s*name\s*,\s*url\s*,\s*isdir\b/.test(script.textContent))) return null;
    const links = [...body.querySelectorAll('a')];
    if (links.some(link => !link.matches('a.icon.dir, a.icon.file'))) return null;
    if (!header.textContent.trim() || !document.getElementById('parentDirLinkBox')) return null;
    return { body, header, parent, table };
  }

  function boot() {
    if (settled) return true;
    if (document.getElementById(MARKER)) {
      settled = true;
      cleanupStartup();
      return true;
    }
    try {
      // Streaming native rows stay usable; inspect them only once parsing completes.
      if (document.readyState === 'loading') return false;
      const native = nativeDirectory();
      if (!native || !document.head || !document.body) return false;
      directoryStudioMetrics.nativeReady = performance.now();
      performance.mark('directory-studio-native-ready');
      if (!guard) {
        prepareGuard(native);
        guard.restore();
      }
      mount(native);
      settled = true;
      cleanupStartup();
      return true;
    } catch (_) {
      failOpen();
      return true;
    }
  }

  function mount(native) {
    const host = document.createElement('div');
    host.id = MARKER;
    guard.host = host;
    host.style.cssText = 'display:block;position:absolute;inset:0 0 auto;min-height:100vh;z-index:1;';
    const shadow = host.attachShadow({ mode: 'open' });

    const memory = Object.create(null);
    const readSetting = (name, fallback) => {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue('directory-studio.' + name, fallback);
      } catch (_) { /* Restricted userscript storage uses memory only. */ }
      return Object.hasOwn(memory, name) ? memory[name] : fallback;
    };
    const saveSetting = (name, value) => {
      memory[name] = value;
      try { if (typeof GM_setValue === 'function') GM_setValue('directory-studio.' + name, value); } catch (_) { /* Nonessential preference storage. */ }
    };
    const valid = (value, values, fallback) => values.includes(value) ? value : fallback;
    const state = {
      view: valid(readSetting('view', 'list'), ['list', 'grid'], 'list'),
      sort: valid(readSetting('sort', 'name'), ['name', 'modified', 'size'], 'name'),
      direction: valid(readSetting('direction', 'asc'), ['asc', 'desc'], 'asc'),
      theme: valid(readSetting('theme', 'light'), ['light', 'dark'], 'light'),
      filter: 'all', query: '', original: false, page: 0
    };
    const currentURL = new URL(location.href);
    currentURL.search = '';
    currentURL.hash = '';
    const decode = value => { try { return decodeURIComponent(value); } catch (_) { return value; } };
    let restored = null;
    try { restored = directoryStudioContext(history.state && history.state[DIRECTORY_STUDIO_CONTEXT_KEY], currentURL.href); } catch (_) { /* Optional entry-scoped state. */ }
    if (restored) Object.assign(state, restored);
    let contextTimer;
    let restoring = true;
    function persistContext() {
      clearTimeout(contextTimer);
      if (restoring || state.original) return;
      const focused = shadow.activeElement;
      const anchors = [...list.querySelectorAll('a[data-entry]')];
      const anchor = anchors.find(node => node.getBoundingClientRect().bottom > 0);
      const value = {
        version: 1, href: currentURL.href, query: state.query, filter: state.filter,
        sort: state.sort, direction: state.direction, view: state.view,
        page: state.page, scroll: window.scrollY, anchor: anchor ? anchor.href : '', offset: anchor ? anchor.getBoundingClientRect().top : 0,
        focus: focused === search ? 'search' : focused && focused.dataset.entry ? focused.dataset.entry : ''
      };
      try {
        const next = directoryStudioMergeContext(history.state, value);
        if (next) history.replaceState(next, '');
      } catch (_) { /* Navigation remains usable when entry storage is unavailable. */ }
    }
    function scheduleContext() {
      if (!restoring) { clearTimeout(contextTimer); contextTimer = setTimeout(persistContext, 180); }
    }
    const parts = currentURL.pathname.split('/').filter(Boolean);
    const drive = parts.length && /^[a-z]:$/i.test(decode(parts[0])) ? decode(parts[0]).toUpperCase() : null;
    const rootDepth = drive || currentURL.hostname ? Math.min(1, parts.length) : 0;
    const rootURL = new URL(currentURL.href);
    rootURL.pathname = rootDepth ? '/' + parts[0] + '/' : '/';
    const parentURL = new URL('../', currentURL);
    const atRoot = currentURL.pathname === rootURL.pathname;
    const pathText = currentURL.hostname
      ? '\\\\' + currentURL.hostname + decode(currentURL.pathname).replaceAll('/', '\\')
      : drive ? decode(currentURL.pathname).slice(1).replaceAll('/', '\\') : decode(currentURL.pathname);
    let entries = [];
    let visibleEntries = [];
    let imageViewer = null;
    function restoreImageFocus(href) {
      if (state.original || !host.isConnected) return;
      const index = visibleEntries.findIndex(item => item.href === href);
      if (index < 0) { search.focus({ preventScroll: true }); return; }
      const page = Math.floor(index / 160);
      const changedPage = state.page !== page;
      if (changedPage) { state.page = page; render(); }
      const anchor = [...list.querySelectorAll('a[data-entry]')].find(node => node.dataset.entry === href);
      if (anchor) {
        anchor.focus({ preventScroll: true });
        if (changedPage) anchor.scrollIntoView({ block: 'nearest' });
      }
    }
    guard.cleanup.push(() => { if (imageViewer) imageViewer.dispose(); });
    let noticeTimer;
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

    const paths = {
      folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
      file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h5',
      search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
      up: 'm6 12 6-6 6 6M12 6v14',
      chevron: 'm9 5 7 7-7 7',
      copy: 'M9 9h12v12H9ZM15 5V3H3v12h2',
      list: 'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
      grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
      moon: 'M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z',
      sun: 'M12 3V1M12 23v-2M3 12H1M23 12h-2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
      drive: 'M4 4h16l2 12v4H2v-4Zm-2 12h20M6 18h.01M10 18h.01',
      arrow: 'M12 4v16m-6-6 6 6 6-6',
      close: 'm6 6 12 12M6 18 18 6',
      shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Zm-4 10 3 3 5-6'
    };
    function icon(name, className = '') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon ' + className })) svg.setAttribute(key, value);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', paths[name] || paths.file);
      svg.append(path);
      return svg;
    }
    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(label, glyph, className = '') {
      const node = element('button', 'button ' + className);
      node.type = 'button';
      node.setAttribute('aria-label', label);
      node.title = label;
      if (glyph) node.append(icon(glyph));
      return node;
    }
    function link(label, href, className = '') {
      const node = element('a', className, label);
      node.href = href;
      return node;
    }
    function option(value, text) {
      const node = element('option', '', text);
      node.value = value;
      return node;
    }

    const css = element('style');
    css.textContent = `
      :host{--bg:#edf3fb;--surface:#fbfdff;--card:#fff;--text:#182b49;--muted:#6c7e97;--line:#dbe5f1;--blue:#2563eb;--wash:#eaf1ff;--rail:#e5edf8;--shadow:0 10px 32px #203b6610;display:block;color:var(--text);font:14px/1.5 'Segoe UI Variable','Microsoft YaHei','Segoe UI',sans-serif;color-scheme:light}
      :host([data-theme=dark]){--bg:#111c2e;--surface:#17253a;--card:#1c2d44;--text:#e0eafb;--muted:#9bb0cc;--line:#30435d;--blue:#8cb4ff;--wash:#253b5d;--rail:#16253a;--shadow:0 10px 32px #0002;color-scheme:dark}
      *{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{-webkit-tap-highlight-color:transparent}button,a{touch-action:manipulation}button{cursor:pointer}a{color:inherit;text-decoration:none}button{color:inherit}button:disabled{opacity:.4;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--blue);outline-offset:3px}svg.icon{width:19px;height:19px;flex-shrink:0}button .icon{pointer-events:none}
      .app{min-height:100vh;background:radial-gradient(ellipse at 90% 0%,#8db7fa24,transparent 48%),var(--bg)}.masthead{height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 30px;border-bottom:1px solid var(--line);gap:12px}.brand{display:flex;align-items:center;gap:12px;font-family:Bahnschrift,'Microsoft YaHei',sans-serif;font-size:17px;font-weight:600;letter-spacing:2px}.brandmark{background:var(--blue);color:var(--card);border-radius:8px;padding:8px;display:flex}.brandmark .icon{width:20px;height:20px}.mastnote{color:var(--muted);font-size:12px;letter-spacing:.5px}.mastactions{display:flex;align-items:center;gap:8px}.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--line);background:var(--card);border-radius:8px;min-height:36px;padding:7px 11px;white-space:nowrap}.button:hover:not(:disabled){border-color:var(--blue);background:var(--wash)}.button.quiet{background:transparent;border-color:transparent}.button.active{background:var(--wash);color:var(--blue);border-color:var(--blue)}.button.icononly{width:36px;padding:7px}
      .workspace{display:grid;grid-template-columns:220px minmax(0,1fr);max-width:1800px;margin:auto;min-height:calc(100vh - 68px)}.rail{padding:30px 20px 24px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:24px;background:linear-gradient(180deg,var(--rail),transparent)}.eyebrow{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:1.5px}.drivecard{display:block;padding:18px 16px 16px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.drivehead{display:flex;align-items:center;justify-content:space-between;color:var(--blue)}.driveletter{font:42px/1 Bahnschrift,Consolas,monospace;letter-spacing:-2px}.drivelabel{display:block;margin-top:14px;color:var(--muted);font-size:12px}.drivecard:hover{border-color:var(--blue)}.railsection{padding:0 3px}.railheading{margin-bottom:13px}.stat{display:flex;justify-content:space-between;margin:11px 0;color:var(--muted);font-size:13px}.stat strong{font:14px Consolas,monospace;color:var(--text)}.localstatus{margin-top:auto;border-top:1px solid var(--line);padding:18px 3px 0;color:var(--muted);font-size:12px}.statusline{display:flex;align-items:center;gap:7px;color:var(--text);margin-bottom:8px}.statusdot{width:6px;height:6px;background:var(--blue);border-radius:50%}.localstatus p{margin:0;line-height:1.8}
      .main{padding:26px 30px 18px;min-width:0}.breadcrumb{display:flex;gap:5px;align-items:center;flex-wrap:wrap;min-width:0;color:var(--muted);font:15px/1.6 Consolas,'Microsoft YaHei',monospace;overflow-wrap:anywhere}.breadcrumb a{padding:3px 5px;border-radius:5px;min-width:0;max-width:100%;overflow-wrap:anywhere}.breadcrumb a:hover{background:var(--wash);color:var(--blue)}.breadcrumb .icon{width:13px;height:13px;color:var(--muted);opacity:.7}.breadcrumb [aria-current=page]{font:600 21px/1.5 Bahnschrift,'Microsoft YaHei',sans-serif;color:var(--blue);background:var(--wash);border:1px solid var(--line);padding:4px 10px;border-radius:8px}.folderheading{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:0 0 16px}.headingtext{min-width:0;flex:1}.subtitle{margin:9px 0 0 5px;color:var(--muted);font-size:12px}.headingactions{display:flex;gap:7px;flex-shrink:0}
      .toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;position:sticky;top:0;z-index:2;background:var(--bg);padding:12px 0;margin-bottom:8px;border-top:1px solid var(--line)}.searchbox{display:flex;align-items:center;gap:9px;flex:1;min-width:180px;max-width:480px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:0 10px;color:var(--muted);height:39px}.searchbox:focus-within{border-color:var(--blue)}.searchbox input{width:100%;min-width:0;border:0;outline:none;background:transparent;color:var(--text);height:100%;font-size:13px}.searchbox input:focus-visible{outline:none}.searchbox kbd{border:1px solid var(--line);border-radius:4px;padding:0 5px;font:12px Consolas,monospace}.clear{border:0;background:transparent;color:var(--muted);display:flex;padding:3px}.clear .icon{width:15px;height:15px}.clear[hidden]{display:none}.filters{display:flex;gap:3px}.filter{border:0;background:transparent;color:var(--muted);padding:8px 10px;border-radius:6px;font-size:13px}.filter[aria-pressed=true]{color:var(--blue);background:var(--wash);font-weight:600}.sortgroup{display:flex;align-items:center;gap:5px;margin-left:auto}.sort{border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--text);height:36px;padding:0 7px;font-size:12px;max-width:110px}.viewgroup{display:flex;gap:4px}.direction.desc .icon{transform:rotate(0)}.direction.asc .icon{transform:rotate(180deg)}
      .listframe{background:var(--surface);border:1px solid var(--line);border-radius:11px;overflow:hidden;box-shadow:var(--shadow)}.listhead,.entry{display:grid;grid-template-columns:minmax(0,1fr) 100px 170px;align-items:center;gap:18px}.listhead{padding:11px 18px;background:var(--wash);font-size:11px;color:var(--muted);letter-spacing:.5px}.listhead span:nth-child(2){text-align:right}.entries{margin:0;padding:0;list-style:none}.entry{padding:11px 18px;min-height:60px;border-bottom:1px solid var(--line)}.entries li:last-child .entry{border-bottom:0}.entry:hover{background:var(--wash)}.entry:focus-visible{outline-offset:-3px}.entryname{display:flex;align-items:center;gap:12px;min-width:0}.fileglyph{height:34px;width:34px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--muted);flex-shrink:0}.isdir .fileglyph{background:var(--wash);color:var(--blue)}.fileglyph .icon{height:21px;width:21px}.namestack{min-width:0}.filename{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}.filekind{display:block;font-size:10px;color:var(--muted);margin-top:1px;letter-spacing:.3px}.size,.date{font:11px/1.6 Consolas,'Microsoft YaHei',monospace;color:var(--muted);white-space:nowrap}.size{text-align:right}.date{overflow:hidden;text-overflow:ellipsis}.grid .listhead{display:none}.grid .entries{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:14px}.grid .entry{height:164px;display:flex;flex-wrap:wrap;align-content:flex-start;align-items:flex-start;gap:9px;border:1px solid var(--line)!important;border-radius:9px;background:var(--card);padding:15px}.grid .entry:hover{border-color:var(--blue)!important;background:var(--wash)}.grid .entryname{width:100%;display:block}.grid .fileglyph{width:36px;height:36px;margin-bottom:9px}.grid .filename{font-size:13px}.grid .filekind{display:none}.grid .size{text-align:left}.grid .date{width:100%;font-size:10px}.empty{padding:64px 20px;text-align:center}.empty .icon{width:34px;height:34px;color:var(--muted);margin-bottom:10px}.empty strong{display:block;font-weight:500;font-size:16px}.empty p{font-size:12px;color:var(--muted);margin:8px 0 0}.footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 2px 0;font-size:11px;color:var(--muted)}.footerpath{font-family:Consolas,monospace;overflow-wrap:anywhere;min-width:0}.notice{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:5;max-width:calc(100vw - 28px);padding:11px 18px;border:1px solid var(--line);background:var(--text);color:var(--card);border-radius:9px;box-shadow:var(--shadow);font-size:13px}.notice:empty{display:none}.restore{box-shadow:0 4px 24px #10244330;border-color:#8ba8d5;background:var(--card);color:var(--text)}[hidden]{display:none!important}
      @media(min-width:1500px){.main{padding-left:40px;padding-right:40px}.workspace{grid-template-columns:240px minmax(0,1fr)}}
      @media(max-width:1000px){.rail{padding:26px 14px}.workspace{grid-template-columns:180px minmax(0,1fr)}.main{padding:24px 22px 16px}.toolbar{gap:8px}.searchbox{max-width:none;flex-basis:100%}.sortgroup{margin-left:auto}.listhead,.entry{grid-template-columns:minmax(0,1fr) 82px 138px;gap:12px}.date{font-size:10px}.mastnote{display:none}}
      @media(max-width:700px){.masthead{height:58px;padding:0 16px}.brand{font-size:13px;letter-spacing:1.3px;gap:8px}.brandmark{padding:6px}.mastactions{gap:3px}.original{font-size:11px;padding:6px 8px}.workspace{display:block;min-height:calc(100vh - 58px)}.rail{display:none}.main{padding:20px 16px 16px}.folderheading{align-items:flex-start;gap:8px;margin:0 0 14px}.headingactions{padding-top:3px}.headingactions .button{padding:7px;width:35px}.copylabel{display:none}.breadcrumb{font-size:14px;gap:3px}.breadcrumb [aria-current=page]{font-size:19px;padding:4px 8px}.toolbar{padding:10px 0;gap:8px}.searchbox{height:39px}.filters{gap:0}.filter{padding:7px 9px;font-size:12px}.sortgroup{gap:3px}.sort{max-width:88px;padding:0 4px;font-size:11px}.viewgroup{gap:3px}.toolbar .icononly{width:31px;min-height:33px;padding:6px}.listhead,.entry{grid-template-columns:minmax(0,1fr) 72px;gap:10px;padding-left:12px;padding-right:12px}.listhead span:last-child,.entry>.date{display:none}.entry{min-height:64px}.entryname{gap:9px}.filename{font-size:12px}.filekind{font-size:10px}.grid .entries{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:9px;padding:10px}.grid .entry{height:158px;padding:12px}.grid .entry>.date{display:block}.footer{font-size:10px}.footerpath{width:100%;order:2}.empty{padding:48px 15px}}
      @media(max-width:390px){.main{padding-left:11px;padding-right:11px}.masthead{padding:0 11px}.brand{font-size:11px;letter-spacing:1px}.brandmark .icon{width:17px;height:17px}.filters{width:100%}.sortgroup{margin-left:0;flex:1}.viewgroup{margin-left:auto}.toolbar{gap:6px}.headingactions{gap:3px}.subtitle{font-size:11px}}
      .favorites{display:grid;gap:4px;min-width:0}.favorites>.eyebrow{margin-bottom:4px}.favorite-row{display:flex;align-items:center;gap:2px;min-width:0;height:36px;border-radius:6px}.favorite-row:hover,.favorite-row[data-current=true],.favorite-row[data-menu-open=true]{background:var(--wash)}.favorite-link{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:36px;padding:6px 8px;color:var(--text);border-radius:6px}.favorite-link>.icon{width:16px;height:16px;color:var(--muted)}.favorite-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.favorite-link[aria-current=page]{font-weight:600}.favorite-link[aria-current=page]>.icon{color:var(--blue)}.favorite-more{flex-shrink:0;width:28px;height:28px;margin-right:4px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--muted);font-size:22px;line-height:1;opacity:0}.favorite-row:hover .favorite-more,.favorite-row:focus-within .favorite-more,.favorite-row[data-menu-open=true] .favorite-more{opacity:1}.favorite-more:hover{background:var(--card);color:var(--text)}.favorite-current[aria-pressed=true]{color:var(--blue);background:var(--wash)}
      .favorite-menu{position:fixed;z-index:20;width:184px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:5px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);box-shadow:var(--shadow)}.favorite-menu-item{display:flex;align-items:center;width:100%;min-height:32px;padding:6px 10px;border:0;border-radius:5px;background:transparent;color:var(--text);font-size:12px;text-align:left}.favorite-menu-item:not(:disabled):hover,.favorite-menu-item:focus-visible{background:var(--wash)}.favorite-menu-item.is-danger{color:#a13e46}.favorite-menu-divider{height:1px;margin:4px 6px;background:var(--line)}:host([data-theme=dark]) .favorite-menu-item.is-danger{color:#f1b0b2}
      @media(hover:none),(pointer:coarse){.favorite-more{opacity:1;width:32px;height:32px}}
      .muted-label{color:var(--muted);font-size:12px}.pager{display:flex;justify-content:center;align-items:center;gap:12px;padding:14px}
      @media(max-width:700px){.rail{display:flex;border:0;padding:12px 16px;gap:0}.rail>.eyebrow,.rail>.drivecard,.rail>.railsection,.rail>.localstatus{display:none}.favorites{display:flex;flex-wrap:wrap;gap:4px;width:100%}.favorites>.eyebrow{width:100%}.favorite-row{width:min(100%,220px);max-width:100%}.headingactions .favorite-current{width:auto}}
    `;
    shadow.append(css);
    host.dataset.theme = state.theme;
    const app = element('div', 'app');
    const masthead = element('header', 'masthead');
    const brand = element('div', 'brand');
    const brandmark = element('span', 'brandmark');
    brandmark.append(icon('folder'));
    brand.append(brandmark, element('span', '', 'DIRECTORY STUDIO'));
    const mastactions = element('div', 'mastactions');
    mastactions.append(element('span', 'mastnote', '本地文件 · 清晰有序'));
    const themeButton = button('切换深色主题', 'moon', 'quiet icononly');
    const originalButton = button('原始目录', null, 'original quiet');
    originalButton.textContent = '原始目录';
    mastactions.append(themeButton, originalButton);
    masthead.append(brand, mastactions);
    const workspace = element('div', 'workspace');
    const rail = element('aside', 'rail');
    rail.setAttribute('aria-label', '目录概览');
    rail.append(element('div', 'eyebrow', 'LOCAL EXPLORER'));
    const driveCard = link('', rootURL.href, 'drivecard');
    driveCard.setAttribute('aria-label', '打开文件系统根目录 ' + (drive || currentURL.hostname || '/'));
    const driveHead = element('div', 'drivehead');
    driveHead.append(element('span', 'driveletter', drive || (currentURL.hostname ? 'LAN' : '/')), icon('drive'));
    driveCard.append(driveHead, element('span', 'drivelabel', currentURL.hostname ? '网络共享根目录' : drive ? '本地磁盘 · 根目录' : '文件系统 · 根目录'));
    rail.append(driveCard);
    const railsection = element('div', 'railsection');
    railsection.append(element('div', 'eyebrow railheading', '当前目录'));
    const counts = {};
    for (const [key, label] of [['all', '全部项目'], ['folders', '文件夹'], ['files', '文件']]) {
      const row = element('div', 'stat');
      counts[key] = element('strong', '', '0');
      row.append(element('span', '', label), counts[key]);
      railsection.append(row);
    }
    rail.append(railsection);
    const favoritesHost = element('section', 'favorites');
    favoritesHost.setAttribute('aria-label', '收藏的目录');
    rail.append(favoritesHost);
    let favorites = directoryStudioFavorites(readSetting('favorites', []));
    let favoritesReady = false;
    const favoritesStore = directoryStudioCreateFavoritesStore({
      read: () => typeof GM !== 'undefined' && typeof GM.getValue === 'function' ? GM.getValue('directory-studio.favorites', []) : readSetting('favorites', []),
      write: value => typeof GM !== 'undefined' && typeof GM.setValue === 'function' ? GM.setValue('directory-studio.favorites', value) : saveSetting('favorites', value),
      subscribe: notify => typeof GM_addValueChangeListener === 'function' ? GM_addValueChangeListener('directory-studio.favorites', (_key, _old, value, remote) => { if (remote) notify(value); }) : null,
      unsubscribe: listener => { if (listener !== null && typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(listener); }
    }, favorites, value => { favorites = value; if (favoritesReady) renderFavorites(); });
    guard.cleanup.push(() => favoritesStore.dispose());
    function changeFavorite(intent) {
      favoritesStore.mutate(intent).catch(error => announce(error.message || '收藏保存失败，请重试。'));
    }
    const favoritesMenu = directoryStudioCreateFavoritesMenu({
      root: shadow, getFavorites: () => favoritesStore.snapshot(), changeFavorite,
      renameLabel: favorite => window.prompt('收藏标签（不会重命名目录）', favorite.label)
    });
    guard.cleanup.push(() => favoritesMenu.dispose());
    function renderFavorites() {
      const active = shadow.activeElement;
      const activeRow = favoritesHost.contains(active) ? active?.closest('.favorite-row') : null;
      const focus = favoritesMenu.focusContext(active) || (activeRow ? { href: activeRow.dataset.href, more: active.classList.contains('favorite-more') } : null);
      const previousRows = [...favoritesHost.querySelectorAll('.favorite-row')];
      const previousIndex = focus ? previousRows.findIndex(row => row.dataset.href === focus.href) : -1;
      favoritesMenu.close();
      favoritesHost.replaceChildren(element('div', 'eyebrow', '收藏目录'));
      if (!favorites.length) favoritesHost.append(element('span', 'muted-label', '收藏常用目录，在这里快速访问。'));
      const current = directoryStudioNormalizeURL(currentURL.href, true);
      favorites.forEach(favorite => {
        const row = element('div', 'favorite-row'); row.dataset.href = favorite.href;
        row.dataset.current = String(favorite.href === current);
        const target = link('', favorite.href, 'favorite-link');
        target.title = favorite.href;
        target.append(icon('folder'), element('span', 'favorite-label', favorite.label));
        if (favorite.href === current) target.setAttribute('aria-current', 'page');
        const more = button('管理收藏：' + favorite.label, null);
        more.className = 'favorite-more'; more.textContent = '⋯';
        more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        more.setAttribute('aria-controls', 'directory-studio-favorites-menu');
        more.addEventListener('click', () => favoritesMenu.toggle(more, favorite.href));
        more.addEventListener('keydown', event => favoritesMenu.triggerKey(event, more, favorite.href));
        row.append(target, more); favoritesHost.append(row);
      });
      if (focus) {
        const rows = [...favoritesHost.querySelectorAll('.favorite-row')];
        const row = rows.find(item => item.dataset.href === focus.href) || rows[Math.min(Math.max(previousIndex, 0), rows.length - 1)];
        const target = row?.querySelector(focus.more ? 'button' : 'a') || favoriteButton;
        target.focus({ preventScroll: true });
      }
      favoriteButton.setAttribute('aria-pressed', String(favorites.some(item => item.href === directoryStudioNormalizeURL(currentURL.href, true))));
    }
    const local = element('div', 'localstatus');
    const statusline = element('div', 'statusline');
    statusline.append(element('span', 'statusdot'), element('span', '', '仅在本机运行'));
    local.append(statusline, element('p', '', '只读取当前目录列表。'), element('p', '', '不上传、不扫描子目录，'), element('p', '', '不修改或删除任何文件。'));
    rail.append(local);
    const main = element('main', 'main');
    const breadcrumb = element('nav', 'breadcrumb');
    breadcrumb.setAttribute('aria-label', '文件夹路径');
    breadcrumb.title = pathText;
    const rootLabel = currentURL.hostname
      ? '\\\\' + currentURL.hostname + (parts.length ? '\\' + decode(parts[0]) : '')
      : drive ? drive + '\\' : '/';
    const crumbRoot = link(rootLabel, rootURL.href);
    crumbRoot.title = rootLabel;
    breadcrumb.append(crumbRoot);
    const start = rootDepth;
    for (let index = start; index < parts.length; index++) {
      const url = new URL(currentURL.href);
      url.pathname = '/' + parts.slice(0, index + 1).join('/') + '/';
      const crumb = link(decode(parts[index]), url.href);
      crumb.title = decode(url.pathname);
      if (index === parts.length - 1) crumb.setAttribute('aria-current', 'page');
      breadcrumb.append(icon('chevron'), crumb);
    }
    if (parts.length === start) crumbRoot.setAttribute('aria-current', 'page');
    const folderheading = element('div', 'folderheading');
    const headingtext = element('div', 'headingtext');
    const subtitle = element('p', 'subtitle');
    headingtext.append(breadcrumb, subtitle);
    const headingactions = element('div', 'headingactions');
    const favoriteButton = button('收藏当前目录', null, 'favorite-current');
    favoriteButton.textContent = '☆';
    favoriteButton.addEventListener('click', () => {
      const href = directoryStudioNormalizeURL(currentURL.href, true);
      changeFavorite({ type: 'toggle', href, label: decode(parts[parts.length - 1] || currentURL.pathname) });
    });
    headingactions.append(favoriteButton);
    const parentLink = link('', atRoot ? rootURL.href : parentURL.href, 'button');
    parentLink.append(icon('up'));
    parentLink.title = atRoot ? '已在根目录' : '上一级目录 (Alt + ↑)';
    parentLink.setAttribute('aria-label', parentLink.title);
    if (atRoot) { parentLink.setAttribute('aria-disabled', 'true'); parentLink.tabIndex = -1; }
    const copy = button('复制当前文件系统路径', 'copy');
    copy.append(element('span', 'copylabel', '复制路径'));
    headingactions.append(parentLink, copy);
    folderheading.append(headingtext, headingactions);
    const toolbar = element('section', 'toolbar');
    toolbar.setAttribute('aria-label', '文件列表工具栏');
    const searchbox = element('div', 'searchbox');
    const search = element('input');
    search.type = 'search';
    search.placeholder = '搜索当前目录…';
    search.setAttribute('aria-label', '搜索当前目录，多个词以空格分隔');
    search.autocomplete = 'off';
    search.value = state.query;
    search.spellcheck = false;
    const slash = element('kbd', '', '/');
    slash.setAttribute('aria-hidden', 'true');
    const clear = button('清空搜索', 'close', 'clear');
    clear.className = 'clear';
    clear.hidden = true;
    searchbox.append(icon('search'), search, clear, slash);
    const filters = element('div', 'filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', '项目类型');
    const filterButtons = {};
    for (const [value, label] of [['all', '全部'], ['folders', '文件夹'], ['files', '文件']]) {
      const filter = button(label, null, 'filter');
      filter.className = 'filter';
      filter.textContent = label;
      filter.setAttribute('aria-pressed', String(state.filter === value));
      filter.addEventListener('click', () => { state.filter = value; state.page = 0; render(); });
      filterButtons[value] = filter;
      filters.append(filter);
    }
    const sortgroup = element('div', 'sortgroup');
    const sort = element('select', 'sort');
    sort.setAttribute('aria-label', '排序字段');
    sort.append(option('name', '名称排序'), option('modified', '修改时间'), option('size', '文件大小'));
    sort.value = state.sort;
    const direction = button('切换排序方向', 'arrow', 'icononly direction');
    sortgroup.append(sort, direction);
    const viewgroup = element('div', 'viewgroup');
    viewgroup.setAttribute('role', 'group');
    viewgroup.setAttribute('aria-label', '显示方式');
    const viewButtons = {};
    for (const [value, label] of [['list', '列表视图'], ['grid', '网格视图']]) {
      const view = button(label, value, 'icononly');
      view.addEventListener('click', () => { state.view = value; state.page = 0; saveSetting('view', value); render(); });
      viewButtons[value] = view;
      viewgroup.append(view);
    }
    toolbar.append(searchbox, filters, sortgroup, viewgroup);
    const frame = element('section', 'listframe');
    frame.setAttribute('aria-label', '目录项目');
    const listhead = element('div', 'listhead');
    listhead.setAttribute('aria-hidden', 'true');
    listhead.append(element('span', '', '名称'), element('span', '', '大小'), element('span', '', '修改时间'));
    const list = element('ul', 'entries');
    const empty = element('div', 'empty');
    frame.append(listhead, list, empty);
    const pager = element('nav', 'pager'); pager.setAttribute('aria-label', '列表分页');
    const previousPage = button('上一页', null); previousPage.textContent = '上一页';
    const nextPage = button('下一页', null); nextPage.textContent = '下一页';
    const pageLabel = element('span', 'muted-label');
    previousPage.addEventListener('click', () => { state.page--; render(); frame.scrollIntoView({ block: 'start' }); });
    nextPage.addEventListener('click', () => { state.page++; render(); frame.scrollIntoView({ block: 'start' }); });
    pager.append(previousPage, pageLabel, nextPage); frame.append(pager);
    const footer = element('footer', 'footer');
    const resultCount = element('span');
    resultCount.setAttribute('role', 'status');
    resultCount.setAttribute('aria-live', 'polite');
    footer.append(element('span', 'footerpath', pathText), resultCount);
    main.append(folderheading, toolbar, frame, footer);
    workspace.append(rail, main);
    app.append(masthead, workspace);
    const notice = element('div', 'notice');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    const restore = button('恢复 Directory Studio 增强视图', 'folder', 'restore');
    restore.append(element('span', '', '返回增强视图'));
    restore.hidden = true;
    shadow.append(app, restore, notice);
    function announce(text) {
      clearTimeout(noticeTimer);
      notice.textContent = text;
      noticeTimer = setTimeout(() => { notice.textContent = ''; }, 4200);
    }
    function setOriginal(original) {
      state.original = original;
      if (imageViewer) imageViewer.close(false);
      favoritesMenu.close();
      app.hidden = original;
      restore.hidden = !original;
      notice.textContent = '';
      if (original) guard.restore();
      else guard.apply(state.theme);
      host.style.cssText = original
        ? 'display:block;position:fixed;bottom:18px;right:18px;z-index:2147483646;'
        : 'display:block;position:absolute;inset:0 0 auto;min-height:100vh;z-index:1;';
      if (original) restore.focus();
      else originalButton.focus();
    }
    function updateTheme() {
      host.dataset.theme = state.theme;
      if (!state.original) guard.apply(state.theme);
      const text = state.theme === 'light' ? '切换深色主题' : '切换浅色主题';
      themeButton.replaceChildren(icon(state.theme === 'light' ? 'moon' : 'sun'));
      themeButton.setAttribute('aria-label', text);
      themeButton.title = text;
    }
    function parseNumber(cell) {
      const value = cell && cell.getAttribute('data-value');
      if (value === null || value === undefined || value.trim() === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    }
    const modifiedTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    function formatModifiedTime(seconds, fallback) {
      if (seconds === null || !Number.isFinite(seconds) || (seconds === 0 && !fallback)) return fallback || '-';
      // Chrome stores directory modification times as Unix seconds.
      const date = new Date(seconds * 1000);
      return Number.isNaN(date.getTime()) ? fallback || '-' : modifiedTimeFormatter.format(date);
    }
    function readEntries() {
      const items = [];
      for (const row of native.body.rows) {
        const source = row.querySelector('a.icon.dir, a.icon.file');
        if (!source || !source.getAttribute('href')) continue;
        let url;
        try { url = new URL(source.getAttribute('href'), document.baseURI); } catch (_) { continue; }
        if (url.protocol !== 'file:') continue;
        const isDirectory = source.classList.contains('dir');
        const rawName = source.textContent;
        const name = isDirectory ? rawName.replace(/\/$/, '') : rawName;
        if (!name || name === '.' || name === '..') continue;
        const size = parseNumber(row.cells[1]);
        const modified = parseNumber(row.cells[2]);
        const sizeText = row.cells[1] ? row.cells[1].textContent.trim() : '';
        const dateText = row.cells[2] ? row.cells[2].textContent.trim() : '';
        items.push({ name, href: url.href, isDirectory, size, modified,
          sizeText: isDirectory ? '-' : sizeText || '-', dateText,
          searchName: name.toLocaleLowerCase(), index: items.length });
      }
      entries = items;
      render();
    }
    function kind(entry) {
      if (entry.isDirectory) return '文件夹';
      const match = /\.([^.]+)$/.exec(entry.name);
      return match && match[1].length <= 12 ? match[1].toUpperCase() + ' 文件' : '文件';
    }
    function compare(a, b) {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      let result = 0;
      if (state.sort !== 'name') {
        const key = state.sort === 'modified' ? 'modified' : 'size';
        if (a[key] === null && b[key] !== null) return 1;
        if (b[key] === null && a[key] !== null) return -1;
        if (a[key] !== null && b[key] !== null) result = a[key] - b[key];
      }
      if (!result) result = collator.compare(a.name, b.name);
      return (state.direction === 'asc' ? result : -result) || a.index - b.index;
    }
    function render() {
      const tokens = state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const visible = entries.filter(item => directoryStudioMatches(item, state, tokens)).sort(compare);
      visibleEntries = visible;
      const imageSequence = directoryStudioImageSequence(visible);
      const pageSize = 160;
      const pages = Math.max(1, Math.ceil(visible.length / pageSize));
      state.page = Math.max(0, Math.min(pages - 1, state.page));
      const fragment = document.createDocumentFragment();
      for (const item of visible.slice(state.page * pageSize, (state.page + 1) * pageSize)) {
        const li = element('li');
        const entry = link('', item.href, 'entry' + (item.isDirectory ? ' isdir' : ''));
        entry.dataset.entry = item.href;
        entry.addEventListener('click', event => {
          persistContext();
          if (!directoryStudioIsImage(item) || !directoryStudioImageClick(event)) return;
          if (!imageViewer) imageViewer = directoryStudioCreateImageViewer({ root: shadow, restoreFocus: restoreImageFocus });
          // Freeze the full filtered/sorted sequence for this viewing session.
          if (imageViewer.open(imageSequence, item.href)) { favoritesMenu.close(); event.preventDefault(); }
        });
        entry.addEventListener('auxclick', persistContext);
        const date = formatModifiedTime(item.modified, item.dateText);
        entry.title = item.name + '\n大小: ' + item.sizeText + '\n修改时间: ' + date;
        if (!item.isDirectory) entry.draggable = true;
        const entryname = element('span', 'entryname');
        const glyph = element('span', 'fileglyph');
        glyph.append(icon(item.isDirectory ? 'folder' : 'file'));
        const stack = element('span', 'namestack');
        stack.append(element('span', 'filename', item.name), element('span', 'filekind', kind(item)));
        entryname.append(glyph, stack);
        const size = element('span', 'size', item.sizeText);
        if (item.size !== null && !item.isDirectory) size.title = item.size.toLocaleString('zh-CN') + ' 字节';
        entry.append(entryname, size, element('span', 'date', date));
        li.append(entry);
        fragment.append(li);
      }
      list.replaceChildren(fragment);
      frame.classList.toggle('grid', state.view === 'grid');
      listhead.hidden = !visible.length;
      empty.hidden = visible.length > 0;
      if (!visible.length) {
        const noEntries = entries.length === 0;
        empty.replaceChildren(icon(noEntries ? 'folder' : 'search'),
          element('strong', '', noEntries ? '这个文件夹是空的' : '没有找到匹配项目'),
          element('p', '', noEntries ? '当前目录没有可显示的文件或文件夹。' : '试试其他关键词，或切换为“全部”。'));
      }
      const folders = entries.filter(item => item.isDirectory).length;
      counts.all.textContent = String(entries.length);
      counts.folders.textContent = String(folders);
      counts.files.textContent = String(entries.length - folders);
      subtitle.textContent = folders + ' 个文件夹 · ' + (entries.length - folders) + ' 个文件';
      resultCount.textContent = '显示 ' + visible.length + ' / ' + entries.length + ' 项';
      for (const [value, control] of Object.entries(filterButtons)) control.setAttribute('aria-pressed', String(state.filter === value));
      for (const [value, control] of Object.entries(viewButtons)) {
        control.setAttribute('aria-pressed', String(state.view === value));
        control.classList.toggle('active', state.view === value);
      }
      direction.classList.toggle('asc', state.direction === 'asc');
      direction.classList.toggle('desc', state.direction === 'desc');
      const directionText = state.direction === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序';
      direction.title = directionText;
      direction.setAttribute('aria-label', directionText);
      clear.hidden = !state.query;
      slash.hidden = !!state.query;
      pager.hidden = pages <= 1;
      previousPage.disabled = state.page === 0; nextPage.disabled = state.page === pages - 1;
      pageLabel.textContent = (state.page + 1) + ' / ' + pages + ' 页 · 每页最多 ' + pageSize + ' 项';
      scheduleContext();
    }
    search.addEventListener('input', () => { state.query = search.value; state.page = 0; render(); });
    clear.addEventListener('click', () => { search.value = ''; state.query = ''; state.page = 0; render(); search.focus(); });
    sort.addEventListener('change', () => { state.sort = sort.value; state.page = 0; saveSetting('sort', state.sort); render(); });
    direction.addEventListener('click', () => {
      state.direction = state.direction === 'asc' ? 'desc' : 'asc';
      saveSetting('direction', state.direction);
      render();
    });
    themeButton.addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      saveSetting('theme', state.theme);
      updateTheme();
    });
    originalButton.addEventListener('click', () => setOriginal(true));
    restore.addEventListener('click', () => setOriginal(false));
    parentLink.addEventListener('click', event => { if (atRoot) event.preventDefault(); });
    copy.addEventListener('click', async () => {
      try {
        if (typeof GM_setClipboard === 'function') {
          await GM_setClipboard(pathText, 'text');
        } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(pathText);
        } else {
          announce('无法自动复制。可在页面底部选择并复制路径。');
          return;
        }
        announce('已复制当前路径');
      } catch (_) { announce('复制失败。可在页面底部选择并复制路径。'); }
    });
    const onKeydown = event => {
      if (state.original || (imageViewer && imageViewer.isOpen) || event.defaultPrevented || event.isComposing) return;
      if (!host.isConnected) return;
      const target = event.composedPath()[0];
      const editable = target instanceof Element && (target.matches('input,textarea,select') || target.isContentEditable);
      if (event.key === '/' && !editable && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault(); search.focus();
      } else if (event.key === 'Escape' && target === search && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (search.value) { search.value = ''; state.query = ''; render(); }
        else search.blur();
      } else if (event.key === 'ArrowUp' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !editable && !atRoot) {
        event.preventDefault(); location.assign(parentURL.href);
      }
    };
    document.addEventListener('keydown', onKeydown);
    guard.cleanup.push(() => document.removeEventListener('keydown', onKeydown));
    favoritesReady = true;
    renderFavorites();
    readEntries();
    document.body.append(host);
    updateTheme();
    directoryStudioMetrics.mounted = performance.now();
    performance.mark('directory-studio-mount-complete');
    host.dataset.nativeReadyMs = String(directoryStudioMetrics.nativeReady);
    host.dataset.mountCompleteMs = String(directoryStudioMetrics.mounted);
    host.dataset.mountMs = String(directoryStudioMetrics.mounted - directoryStudioMetrics.nativeReady);
    const cancelListReady = directoryStudioAfterListPaint(() => {
      if (restored) {
        const target = [...list.querySelectorAll('a[data-entry]')].find(node => node.href === restored.anchor);
        if (target) window.scrollBy(0, target.getBoundingClientRect().top - restored.offset);
        else window.scrollTo(0, restored.scroll);
        const focus = restored.focus === 'search' ? search : [...list.querySelectorAll('[data-entry]')].find(node => node.dataset.entry === restored.focus);
        if (focus) focus.focus({ preventScroll: true });
      }
      restoring = false;
    }, () => {
      if (!host.isConnected || state.original) return;
      directoryStudioMetrics.interactive = performance.now();
      performance.mark('directory-studio-enhanced-interactive');
      host.dataset.interactiveMs = String(directoryStudioMetrics.interactive);
      host.dispatchEvent(new CustomEvent('directory-studio-interactive', {
        detail: {
          navigationMs: directoryStudioMetrics.interactive, nativeReadyMs: directoryStudioMetrics.nativeReady,
          mountCompleteMs: directoryStudioMetrics.mounted, mountMs: directoryStudioMetrics.mounted - directoryStudioMetrics.nativeReady,
          injectionToInteractiveMs: directoryStudioMetrics.interactive - directoryStudioMetrics.started
        }, bubbles: true
      }));
      favoritesStore.refresh().catch(() => {});
    });
    guard.cleanup.push(cancelListReady);
    const onScroll = () => scheduleContext();
    const onFocus = () => scheduleContext();
    window.addEventListener('scroll', onScroll, { passive: true }); shadow.addEventListener('focusin', onFocus);
    guard.cleanup.push(() => { window.removeEventListener('scroll', onScroll); shadow.removeEventListener('focusin', onFocus); clearTimeout(contextTimer); });
    // Keep a bounded follow-up observer for any late native row updates.
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; readEntries(); });
    });
    observer.observe(native.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'data-value', 'class'] });
    guard.cleanup.push(() => observer.disconnect());
    const stopObservation = () => observer.disconnect();
    const observationTimer = setTimeout(stopObservation, 15000);
    guard.cleanup.push(() => clearTimeout(observationTimer));
    window.addEventListener('pagehide', event => {
      favoritesMenu.close();
      if (imageViewer) imageViewer.close(false);
      cancelListReady();
      if (!event.persisted) favoritesStore.dispose();
      persistContext(); clearTimeout(contextTimer); clearTimeout(observationTimer); observer.disconnect(); clearTimeout(noticeTimer);
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', readEntries, { once: true });
  }

  // Observing Document is safe even before the parser creates <html>.
  startupObserver = new MutationObserver(boot);
  startupObserver.observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener('DOMContentLoaded', boot, { once: true });
  window.addEventListener('pagehide', failOpen, { once: true });
  startupTimer = setTimeout(failOpen, 5000);
  boot();
})();
