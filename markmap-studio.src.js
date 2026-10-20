const MARKMAP_STUDIO_LIMITS = Object.freeze({ blocks: 6, bytes: 30 * 1024, nodes: 300, depth: 20, lines: 600, timeout: 10000 });
const MARKMAP_STUDIO_CHANNEL = 'directory-studio-markmap-v1';

function validateMarkmapSource(source) {
  if (typeof source !== 'string' || source.length > MARKMAP_STUDIO_LIMITS.bytes || new TextEncoder().encode(source).length > MARKMAP_STUDIO_LIMITS.bytes) throw new Error('Markmap source exceeds 30 KiB.');
  if (source.split(/\r\n|\r|\n/).length > MARKMAP_STUDIO_LIMITS.lines) throw new Error('Markmap source exceeds 600 lines.');
  if (/^\s*---(?:\r?\n|$)/.test(source.replace(/^\uFEFF/, ''))) throw new Error('Markmap frontmatter and document options are not supported.');
}

function normalizeMarkmapTree(root) {
  let count = 0;
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const visit = (node, depth) => {
    if (++count > MARKMAP_STUDIO_LIMITS.nodes || depth > MARKMAP_STUDIO_LIMITS.depth) throw new Error('Markmap exceeds 300 nodes or depth 20.');
    if (!node || typeof node.content !== 'string' || (node.children !== undefined && !Array.isArray(node.children))) throw new Error('Invalid Markmap tree.');
    // Never put transformer HTML into a live document. Rebuild every label as escaped text.
    const inert = new DOMParser().parseFromString(node.content, 'text/html');
    inert.querySelectorAll('script,style,iframe,object,embed,img,svg,math,link,meta').forEach(element => element.remove());
    return { content: escape(inert.body.textContent || ''), children: (node.children || []).map(child => visit(child, depth + 1)) };
  };
  return visit(root, 0);
}

function markmapSandboxMain(config) {
  'use strict';
  let map = null;
  let request = null;
  let started = false;
  let disposed = false;
  let queue = Promise.resolve();
  const send = message => parent.postMessage({ channel: config.channel, nonce: config.nonce, id: request, ...message }, '*');
  const dispose = () => {
    disposed = true;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', dispose);
    window.removeEventListener('unload', dispose);
    if (map) { map.destroy(); map = null; }
  };
  const redraw = async fold => {
    const visit = (node, depth) => {
      node.payload = { fold: fold ? 1 : 0 };
      node.children.forEach(child => visit(child, depth + 1));
    };
    visit(map.state.data, 0);
    await map.setData();
    if (!disposed) await map.fit();
  };
  async function execute(message) {
    if (disposed) return;
    if (message.kind === 'init') {
      validateMarkmapSource(message.source);
      const transformer = new markmap.Transformer([]);
      transformer.md.set({ html: false, linkify: false, maxNesting: 20 });
      transformer.md.renderer.rules.image = (tokens, index) => transformer.md.utils.escapeHtml(tokens[index].content || '[image]');
      const root = normalizeMarkmapTree(transformer.transform(message.source).root);
      if (disposed) return;
      document.documentElement.dataset.theme = message.theme === 'dark' ? 'dark' : 'light';
      map = markmap.Markmap.create('#map', { duration: 0, initialExpandLevel: 2, maxWidth: 260, zoom: true, pan: true, scrollForPan: false, autoFit: false });
      await map.setData(root);
      if (disposed) return;
      await map.fit();
      if (!disposed) send({ kind: 'rendered' });
    } else if (map && message.kind === 'fit') await map.fit();
    else if (map && message.kind === 'expand') await redraw(false);
    else if (map && message.kind === 'collapse') await redraw(true);
  }
  function onMessage(event) {
    const message = event.data;
    if (event.source !== parent || !message || message.channel !== config.channel || message.nonce !== config.nonce || typeof message.id !== 'string') return;
    if (message.kind === 'init') {
      if (started) return;
      started = true;
      request = message.id;
    } else if (!started || message.id !== request || !['fit', 'expand', 'collapse', 'dispose'].includes(message.kind)) return;
    if (message.kind === 'dispose') { dispose(); return; }
    queue = queue.then(() => execute(message)).catch(error => {
      if (!disposed) send({ kind: 'error', error: String(error && error.message || 'Markmap rendering failed.').slice(0, 240) });
      dispose();
    });
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', dispose);
  window.addEventListener('unload', dispose);
  send({ kind: 'ready' });
}

function createMarkmapSandboxDocument(nonce, bundle) {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  const escapeScript = source => source.replace(/<\/script/gi, '<\\/script');
  const bootstrap = 'const MARKMAP_STUDIO_LIMITS = ' + JSON.stringify(MARKMAP_STUDIO_LIMITS) + ';\n' + validateMarkmapSource.toString() + '\n' + normalizeMarkmapTree.toString() + '\n(' + markmapSandboxMain.toString() + ')(' + JSON.stringify({ channel: MARKMAP_STUDIO_CHANNEL, nonce }) + ');';
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '">' +
    '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fbfdff;color:#182b49}html[data-theme=dark],html[data-theme=dark] body{background:#17253a;color:#e0eafb}#map{width:100%;height:100%;display:block;--markmap-text-color:#182b49;--markmap-circle-open-bg:#fbfdff;font:14px "Segoe UI","Microsoft YaHei",sans-serif}html[data-theme=dark] #map{--markmap-text-color:#e0eafb;--markmap-circle-open-bg:#17253a}.markmap-foreign{color:var(--markmap-text-color)}.markmap-node circle{cursor:pointer}</style></head>' +
    '<body><svg id="map" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Interactive Markmap"></svg><script>' + escapeScript(bundle) + '</script><script>' + escapeScript(bootstrap) + '</script></body></html>';
}

function createMarkmapPreviewController(host, preview) {
  let generation = 0;
  let disposed = false;
  let cleanups = [];
  const invalidate = () => {
    generation++;
    cleanups.splice(0).forEach(cleanup => cleanup());
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  return {
    invalidate,
    dispose() { disposed = true; invalidate(); },
    async render(blocks, theme, isCurrent = () => true) {
      invalidate();
      if (disposed) return;
      const ticket = generation;
      let bundle;
      for (let index = 0; index < blocks.length; index++) {
        if (disposed || ticket !== generation || !isCurrent()) return;
        const card = preview.querySelector('[data-markmap-index="' + index + '"]');
        if (!card || !card.isConnected) continue;
        const source = blocks[index];
        card.replaceChildren();
        card.dataset.state = 'waiting';
        const heading = element('div', 'lts-markmap-heading');
        heading.append(element('span', 'lts-markmap-label', 'MARKMAP'));
        const controls = element('div', 'lts-markmap-controls');
        const status = element('p', 'lts-markmap-status', '进入可见区域后加载交互脑图。');
        status.setAttribute('role', 'status');
        const disclosure = element('details', 'lts-markmap-source');
        const code = element('code', '', source);
        const pre = element('pre', '');
        pre.append(code);
        disclosure.append(element('summary', '', '查看脑图源码'), pre);
        heading.append(controls);
        card.append(heading, status, disclosure);
        const buttons = [];
        let frame = null;
        let timer;
        let observer;
        let visibilityObserver;
        let resizeFrame;
        let closed = false;
        let initialized = false;
        let rendered = false;
        let started = false;
        let frameReady = false;
        let intersecting = false;
        let needsFit = false;
        let remaining = MARKMAP_STUDIO_LIMITS.timeout;
        let budgetStarted = null;
        const nonce = crypto.randomUUID();
        const id = nonce + ':' + index;
        const current = () => !closed && !disposed && ticket === generation && isCurrent() && host.isConnected && card.isConnected;
        const visible = () => intersecting && document.visibilityState === 'visible';
        const pauseBudget = () => {
          if (budgetStarted !== null) remaining = Math.max(0, remaining - (performance.now() - budgetStarted));
          budgetStarted = null;
          clearTimeout(timer);
          timer = undefined;
        };
        const send = kind => {
          if (frame && current()) frame.contentWindow?.postMessage({ channel: MARKMAP_STUDIO_CHANNEL, nonce, id, kind }, '*');
        };
        const close = () => {
          if (closed) return;
          if (frame) frame.contentWindow?.postMessage({ channel: MARKMAP_STUDIO_CHANNEL, nonce, id, kind: 'dispose' }, '*');
          closed = true;
          pauseBudget();
          cancelAnimationFrame(resizeFrame);
          observer?.disconnect();
          visibilityObserver?.disconnect();
          document.removeEventListener('visibilitychange', updateVisibility);
          window.removeEventListener('message', onMessage);
          buttons.forEach(button => { button.disabled = true; });
          frame?.remove();
          frame = null;
        };
        const fail = message => {
          if (!current()) return;
          card.dataset.state = 'error';
          status.textContent = message;
          disclosure.open = true;
          close();
        };
        const start = () => {
          started = true;
          try {
            if (bundle === undefined) bundle = getTextStudioMarkmapBundle();
            if (typeof bundle !== 'string' || !bundle.trim()) throw new Error('Markmap 缓存资源不可用；请重新安装本地候选。');
            frame.srcdoc = createMarkmapSandboxDocument(nonce, bundle);
          } catch (error) { fail(String(error && error.message || 'Markmap rendering failed.')); }
        };
        function updateVisibility() {
          if (!current()) return;
          if (rendered) {
            if (visible() && needsFit) {
              needsFit = false;
              cancelAnimationFrame(resizeFrame);
              resizeFrame = requestAnimationFrame(() => { if (visible()) send('fit'); else needsFit = true; });
            }
            return;
          }
          if (!visible()) {
            pauseBudget();
            card.dataset.state = 'waiting';
            status.textContent = started ? '等待返回可见区域；启动等待计时已暂停。' : '进入可见区域后加载交互脑图。';
            return;
          }
          card.dataset.state = 'loading';
          status.textContent = '正在加载交互脑图…';
          if (budgetStarted === null) {
            budgetStarted = performance.now();
            timer = setTimeout(() => {
              pauseBudget();
              if (!visible() || remaining > 0) { updateVisibility(); return; }
              fail('脑图启动或渲染累计可见等待超过 10 秒，已停止此预览。此等待超时不是 CPU 硬限制；源码仍可查看。');
            }, remaining);
          }
          if (!started) start();
          if (current() && frameReady && !initialized) {
            initialized = true;
            frame.contentWindow?.postMessage({ channel: MARKMAP_STUDIO_CHANNEL, nonce, id, kind: 'init', source, theme }, '*');
          }
        }
        const onMessage = event => {
          const message = event.data;
          if (!current() || !frame || event.source !== frame.contentWindow || !message || message.channel !== MARKMAP_STUDIO_CHANNEL || message.nonce !== nonce) return;
          if (message.kind === 'ready' && started && !frameReady && message.id === null) {
            frameReady = true;
            updateVisibility();
          } else if (initialized && message.id === id && message.kind === 'rendered' && !rendered) {
            rendered = true;
            pauseBudget();
            card.dataset.state = 'ready';
            status.textContent = '点击节点圆点展开或收起；拖动画布平移，滚轮缩放。';
            buttons.forEach(button => { button.disabled = false; });
          } else if (initialized && message.id === id && message.kind === 'error') fail('脑图渲染失败：' + (typeof message.error === 'string' ? message.error.slice(0, 240) : '未知错误。'));
        };
        cleanups.push(close);
        for (const [kind, label] of [['fit', '适应窗口'], ['expand', '全部展开'], ['collapse', '全部收起']]) {
          const button = element('button', 'lts-button', label);
          button.type = 'button';
          button.disabled = true;
          const onClick = () => {
            if (!rendered) return;
            if (kind === 'fit' && !visible()) { needsFit = true; return; }
            send(kind);
          };
          button.addEventListener('click', onClick);
          cleanups.push(() => button.removeEventListener('click', onClick));
          buttons.push(button);
          controls.append(button);
        }
        try {
          if (index >= MARKMAP_STUDIO_LIMITS.blocks) throw new Error('每次预览最多显示 6 个 Markmap。');
          validateMarkmapSource(source);
          if (!current()) { close(); return; }
          frame = element('iframe', 'lts-markmap-frame');
          frame.title = 'Markmap 交互脑图 ' + (index + 1);
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.setAttribute('referrerpolicy', 'no-referrer');
          window.addEventListener('message', onMessage);
          card.insertBefore(frame, disclosure);
          if (typeof IntersectionObserver !== 'function') throw new Error('浏览器不支持可见区域检测；请查看脑图源码。');
          visibilityObserver = new IntersectionObserver(entries => {
            if (!current()) return;
            const entry = entries[entries.length - 1];
            intersecting = !!entry && entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
            updateVisibility();
          }, { root: preview, threshold: 0 });
          document.addEventListener('visibilitychange', updateVisibility);
          visibilityObserver.observe(frame);
          if (typeof ResizeObserver === 'function') {
            let width = -1;
            observer = new ResizeObserver(entries => {
              const next = Math.round(entries[0].contentRect.width);
              if (next <= 0 || next === width) return;
              width = next;
              cancelAnimationFrame(resizeFrame);
              resizeFrame = requestAnimationFrame(() => {
                if (!rendered) return;
                if (visible()) send('fit');
                else needsFit = true;
              });
            });
            observer.observe(card);
          }
        } catch (error) { fail(String(error && error.message || 'Markmap rendering failed.')); }
      }
    }
  };
}
