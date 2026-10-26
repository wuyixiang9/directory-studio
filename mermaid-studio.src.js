const MERMAID_STUDIO_LIMITS = Object.freeze({ blocks: 12, bytes: 30 * 1024, edges: 200, svgBytes: 2 * 1024 * 1024, timeout: 8000 });
const MERMAID_STUDIO_CHANNEL = 'directory-studio-mermaid-v1';

function validateMermaidSource(source) {
  if (typeof source !== 'string' || source.length > 30 * 1024 || new TextEncoder().encode(source).length > 30 * 1024) throw new Error('图表超过 30 KiB 限制。');
  const text = source.replace(/^\uFEFF/, '').trimStart();
  if (/%%\s*\{/.test(text) || /^---(?:\r?\n|$)/.test(text)) throw new Error('不支持 Mermaid 配置指令或 frontmatter；请只保留图表定义。');
  const first = text.split(/\r?\n/).find(line => line.trim() && !line.trimStart().startsWith('%%')) || '';
  if (!/^\s*(?:flowchart\b|graph\b|sequenceDiagram\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|gantt\b|pie\b|gitGraph\b)/i.test(first)) throw new Error('支持流程、时序、类、状态、ER、甘特、饼图和 Git 图；其他图表类型暂不支持。');
}

function mermaidSandboxMain(config) {
  'use strict';
  let busy = false;
  const send = message => parent.postMessage({ channel: config.channel, nonce: config.nonce, ...message }, '*');
  window.addEventListener('message', async event => {
    const message = event.data;
    if (event.source !== parent || !message || message.channel !== config.channel || message.nonce !== config.nonce || message.kind !== 'render') return;
    if (!Number.isSafeInteger(message.id) || message.id < 1 || typeof message.code !== 'string' || !['light', 'dark'].includes(message.theme)) return;
    if (busy) { send({ kind: 'result', id: message.id, error: '渲染器忙，请重试。' }); return; }
    busy = true;
    const stage = document.getElementById('stage');
    try {
      validateMermaidSource(message.code);
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        htmlLabels: false, theme: message.theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', maxTextSize: 30 * 1024, maxEdges: 200,
        flowchart: { htmlLabels: false, useMaxWidth: true }, class: { htmlLabels: false },
        secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'htmlLabels', 'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'fontFamily', 'flowchart', 'class']
      });
      stage.replaceChildren();
      const result = await mermaid.render('lts_mermaid_' + message.id, message.code, stage);
      if (typeof result.svg !== 'string' || result.svg.length > 2 * 1024 * 1024) throw new Error('图表输出过大。');
      send({ kind: 'result', id: message.id, svg: result.svg });
    } catch (error) {
      send({ kind: 'result', id: message.id, error: String(error && error.message || '图表语法无效。').slice(0, 180) });
    } finally {
      stage.replaceChildren();
      busy = false;
    }
  });
  // The bundled library is initialized before DOMContentLoaded can trigger auto-rendering.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
  send({ kind: 'ready' });
}

function createMermaidSandboxDocument(nonce) {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  const escapeScript = source => source.replace(/<\/script/gi, '<\\/script');
  const bootstrap = validateMermaidSource.toString() + '\n(' + mermaidSandboxMain.toString() + ')(' + JSON.stringify({ channel: MERMAID_STUDIO_CHANNEL, nonce }) + ');';
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '">' +
    '<style>html,body{margin:0;background:transparent;font:16px "Segoe UI","Microsoft YaHei",sans-serif}#stage{width:1160px;min-height:100px}</style></head>' +
    '<body><main id="stage"></main><script>' + escapeScript(getTextStudioMermaidBundle()) + '</script><script>' + escapeScript(bootstrap) + '</script></body></html>';
}

function createMermaidRenderer(host) {
  let frame = null;
  let ready = null;
  let waitingReady = null;
  let request = null;
  let ticket = 0;
  let sequence = 0;
  let nonce = '';
  let disposed = false;
  let queue = Promise.resolve();
  function closeFrame(reason = new Error('图表渲染已取消。')) {
    const opening = waitingReady;
    const pending = request;
    waitingReady = request = null;
    if (opening) { clearTimeout(opening.timer); opening.reject(reason); }
    if (pending) { clearTimeout(pending.timer); pending.reject(reason); }
    window.removeEventListener('message', onMessage);
    if (frame) frame.remove();
    frame = ready = null;
    nonce = '';
  }
  function onMessage(event) {
    const data = event.data;
    if (!frame || event.source !== frame.contentWindow || !data || data.channel !== MERMAID_STUDIO_CHANNEL || data.nonce !== nonce) return;
    if (data.kind === 'ready' && waitingReady) {
      const opening = waitingReady;
      waitingReady = null;
      clearTimeout(opening.timer);
      opening.resolve();
    } else if (data.kind === 'result' && request && data.id === request.id) {
      const pending = request;
      request = null;
      clearTimeout(pending.timer);
      if (typeof data.svg === 'string' && data.svg.length <= MERMAID_STUDIO_LIMITS.svgBytes) pending.resolve({ svg: data.svg, id: data.id });
      else pending.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 180) : '图表输出无效。'));
    }
  }
  function ensureFrame() {
    if (ready) return ready;
    nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), number => number.toString(16).padStart(8, '0')).join('');
    frame = document.createElement('iframe');
    frame.className = 'lts-mermaid-sandbox';
    frame.title = '隔离的离线 Mermaid 渲染器';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.referrerPolicy = 'no-referrer';
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none;';
    window.addEventListener('message', onMessage);
    ready = new Promise((resolve, reject) => {
      waitingReady = { resolve, reject, timer: setTimeout(() => closeFrame(new Error('图表渲染器启动超时。')), MERMAID_STUDIO_LIMITS.timeout) };
    });
    const opening = ready;
    try {
      if (typeof environment !== 'undefined' && typeof environment.sandboxURL === 'function') frame.src = environment.sandboxURL('mermaid', nonce);
      else frame.srcdoc = createMermaidSandboxDocument(nonce);
      host.append(frame);
    } catch (error) { closeFrame(error); }
    return opening;
  }
  return {
    render(code, theme) {
      const current = ticket;
      const result = queue.catch(() => {}).then(async () => {
        if (disposed || current !== ticket) throw new Error('图表渲染已取消。');
        validateMermaidSource(code);
        await ensureFrame();
        if (disposed || current !== ticket || !frame) throw new Error('图表渲染已取消。');
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          request = { id, resolve, reject, timer: setTimeout(() => closeFrame(new Error('图表渲染超时，请简化图表。')), MERMAID_STUDIO_LIMITS.timeout) };
          try { frame.contentWindow.postMessage({ channel: MERMAID_STUDIO_CHANNEL, nonce, kind: 'render', id, code, theme }, '*'); }
          catch (error) { closeFrame(error); }
        });
      });
      queue = result.catch(() => {});
      return result;
    },
    reset() { ticket++; closeFrame(); },
    dispose() { disposed = true; ticket++; closeFrame(); }
  };
}

function sanitizeMermaidSVG(source, renderID) {
  if (typeof source !== 'string' || source.length > MERMAID_STUDIO_LIMITS.svgBytes || new TextEncoder().encode(source).length > MERMAID_STUDIO_LIMITS.svgBytes || /<!DOCTYPE|<!ENTITY|<\?/i.test(source)) throw new Error('图表 SVG 无效。');
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = parsed.documentElement;
  const namespace = 'http://www.w3.org/2000/svg';
  const rootID = 'lts_mermaid_' + renderID;
  if (parsed.querySelector('parsererror') || svg.localName !== 'svg' || svg.namespaceURI !== namespace || svg.id !== rootID) throw new Error('图表 SVG 无法安全解析。');
  const tags = new Set(['svg', 'g', 'defs', 'style', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'marker', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'stop', 'use']);
  const attributes = new Set(['id', 'class', 'style', 'xmlns', 'xmlns:xlink', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-roledescription', 'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'dx', 'dy', 'rotate', 'textlength', 'lengthadjust', 'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient', 'clippathunits', 'patternunits', 'patterncontentunits', 'patterntransform', 'gradientunits', 'gradienttransform', 'offset', 'spreadmethod', 'href', 'xlink:href']);
  const properties = new Set(['color', 'fill', 'stroke', 'stop-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'opacity', 'display', 'visibility', 'white-space', 'paint-order', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'text-decoration', 'text-transform', 'letter-spacing', 'word-spacing', 'line-height', 'width', 'height', 'max-width', 'background-color', 'rx', 'ry']);
  const resources = new Set(['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask']);
  function safeValue(property, value) {
    if (!properties.has(property) || !value || value.length > 500 || /[\\@<>{};/]/.test(value)) return '';
    if (/url/i.test(value)) {
      return resources.has(property) && /^url\(\s*(?:"#[A-Za-z_][\w.:-]*"|'#[A-Za-z_][\w.:-]*'|#[A-Za-z_][\w.:-]*)\s*\)$/i.test(value) ? value : '';
    }
    if (!/^[A-Za-z0-9_\s#.,%+'"()\-]*$/.test(value)) return '';
    if (/[()]/.test(value) && !/^(?:rgba?|hsla?)\([\d.,%+\-\s]+\)$/i.test(value)) return '';
    return value;
  }
  function safeDeclarations(declaration) {
    const output = [];
    for (let index = 0; index < declaration.length; index++) {
      const property = declaration.item(index);
      const name = property.toLowerCase();
      const value = safeValue(name, declaration.getPropertyValue(property).trim());
      if (value) output.push(name + ':' + value);
    }
    return output.join(';');
  }
  function cleanCSS(css, inline = false) {
    // Parse in an unadopted sheet; discard unsafe rules/values, not their safe neighbors.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(inline ? 'x{' + css + '}' : css);
      if (inline) return sheet.cssRules.length === 1 && sheet.cssRules[0].type === CSSRule.STYLE_RULE ? safeDeclarations(sheet.cssRules[0].style) : '';
      const output = [];
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type !== CSSRule.STYLE_RULE || !rule.selectorText || !rule.selectorText.split(',').every(selector => selector.trim().startsWith('#' + rootID) && !/:host|::slotted|:global|[\\@]/i.test(selector))) continue;
        const value = safeDeclarations(rule.style);
        if (value) output.push(rule.selectorText + '{' + value + '}');
      }
      return output.join('\n');
    } catch (_) { return ''; }
  }
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    if (!svg.contains(node) && node !== svg) continue;
    if (node.localName.toLowerCase() === 'a') { node.replaceWith(...node.childNodes); continue; }
    if (node.namespaceURI !== namespace || !tags.has(node.localName.toLowerCase())) { node.remove(); continue; }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on') || (!attributes.has(name) && !properties.has(name))) { node.removeAttributeNode(attribute); continue; }
      if (name === 'style') {
        const clean = cleanCSS(value, true);
        if (clean) node.setAttribute('style', clean); else node.removeAttribute('style');
      } else if (name === 'href' || name === 'xlink:href') {
        if (!/^(?:textpath|use)$/.test(node.localName.toLowerCase()) || !/^#[A-Za-z_][\w.:-]*$/.test(value)) node.removeAttributeNode(attribute);
      } else if (properties.has(name)) {
        const clean = safeValue(name, value);
        if (!clean) node.removeAttributeNode(attribute);
      } else if (name === 'id' && !/^[A-Za-z_][\w.:-]{0,180}$/.test(value)) node.removeAttributeNode(attribute);
      else if ((name === 'xmlns' && value !== namespace) || (name === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink')) node.removeAttributeNode(attribute);
    }
    if (node.localName.toLowerCase() === 'style') node.textContent = cleanCSS(node.textContent);
  }
  svg.setAttribute('xmlns', namespace);
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
  return new XMLSerializer().serializeToString(svg);
}

function createMermaidHeightChoices() {
  const choices = new Map();
  return {
    reconcile(blocks) {
      const occurrences = new Map();
      const present = new Set();
      const keys = blocks.map((source, index) => {
        if (index >= MERMAID_STUDIO_LIMITS.blocks) return null;
        try { validateMermaidSource(source); } catch (_) { return null; }
        const occurrence = occurrences.get(source) || 0;
        occurrences.set(source, occurrence + 1);
        const key = JSON.stringify([source, occurrence]);
        present.add(key);
        return key;
      });
      for (const key of choices.keys()) if (!present.has(key)) choices.delete(key);
      for (const key of present) if (!choices.has(key)) choices.set(key, false);
      return keys;
    },
    isFixed(key) { return choices.get(key) === true; },
    toggle(key) {
      if (!choices.has(key)) return null;
      const fixed = !choices.get(key);
      choices.set(key, fixed);
      return fixed;
    },
    clear() { choices.clear(); },
    get size() { return choices.size; }
  };
}

function createMermaidPreviewController(host, preview) {
  const renderer = createMermaidRenderer(host);
  const heightChoices = createMermaidHeightChoices();
  let surfaceSequence = 0;
  let generation = 0;
  let disposed = false;
  const blobs = new Set();
  const imageTimers = new Set();
  function invalidate() {
    generation++;
    renderer.reset();
    imageTimers.forEach(timer => clearTimeout(timer));
    imageTimers.clear();
    blobs.forEach(value => URL.revokeObjectURL(value));
    blobs.clear();
  }
  return {
    invalidate,
    dispose() { disposed = true; heightChoices.clear(); invalidate(); renderer.dispose(); },
    async render(blocks, theme, active) {
      const current = generation;
      const live = () => !disposed && current === generation && host.isConnected && active();
      if (!live()) return;
      const heightKeys = heightChoices.reconcile(blocks);
      const jobs = [];
      for (let index = 0; index < blocks.length; index++) {
        const card = preview.querySelector('[data-mermaid-index="' + index + '"]');
        if (!card) continue;
        const key = heightKeys[index];
        const heading = document.createElement('div');
        heading.className = 'lts-mermaid-heading';
        const label = document.createElement('div');
        label.className = 'lts-mermaid-label';
        label.textContent = 'MERMAID';
        const heightButton = document.createElement('button');
        heightButton.type = 'button';
        heightButton.className = 'lts-button lts-mermaid-height';
        heading.append(label, heightButton);
        const status = document.createElement('p');
        status.className = 'lts-mermaid-status';
        status.setAttribute('role', 'status');
        status.textContent = '等待渲染…';
        const surface = document.createElement('div');
        surface.className = 'lts-mermaid-surface';
        surface.id = 'lts-mermaid-surface-' + (++surfaceSequence);
        heightButton.setAttribute('aria-controls', surface.id);
        const applyHeight = fixed => {
          surface.dataset.height = fixed ? 'fixed' : 'auto';
          surface.scrollTop = 0;
          heightButton.textContent = fixed ? '自动撑开' : '固定高度';
          heightButton.setAttribute('aria-pressed', String(fixed));
          const description = fixed
            ? '自动撑开：取消 640px 高度上限；当前为固定高度。'
            : '固定高度：图表最多显示 640px 并在图内滚动；当前自动撑开。';
          heightButton.title = description;
          heightButton.setAttribute('aria-label', description);
        };
        applyHeight(heightChoices.isFixed(key));
        heightButton.addEventListener('click', () => {
          if (heightButton.disabled || !live() || !card.isConnected || !preview.contains(card)) return;
          const fixed = heightChoices.toggle(key);
          if (fixed !== null) applyHeight(fixed);
        });
        const details = document.createElement('details');
        details.className = 'lts-mermaid-source';
        const summary = document.createElement('summary');
        summary.textContent = '查看图表源码';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = blocks[index];
        pre.append(code);
        details.append(summary, pre);
        card.replaceChildren(heading, status, surface, details);
        card.dataset.state = 'pending';
        const fail = message => {
          card.dataset.state = 'error';
          status.textContent = message;
          details.open = true;
          heightButton.disabled = true;
          heightButton.title = '图表未渲染，暂不可切换高度；错误提示和源码不会折叠。';
          heightButton.setAttribute('aria-label', heightButton.textContent + '不可用：' + heightButton.title);
        };
        if (index >= MERMAID_STUDIO_LIMITS.blocks) { fail('每次预览最多渲染 12 个图表；源码仍可编辑、复制和下载。'); continue; }
        try { validateMermaidSource(blocks[index]); } catch (error) { fail(error.message); continue; }
        jobs.push({ card, status, surface, fail, source: blocks[index] });
      }
      for (const job of jobs) {
        if (!live()) return;
        job.status.textContent = '正在离线渲染…';
        try {
          const result = await renderer.render(job.source, theme);
          if (!live()) return;
          const sanitized = sanitizeMermaidSVG(result.svg, result.id);
          if (!live()) return;
          const blob = URL.createObjectURL(new Blob([sanitized], { type: 'image/svg+xml' }));
          blobs.add(blob);
          if (!live()) { URL.revokeObjectURL(blob); blobs.delete(blob); return; }
          const image = document.createElement('img');
          image.className = 'lts-mermaid-image';
          image.alt = 'Mermaid 图表；完整定义见图表源码';
          let finished = false;
          const finish = success => {
            if (finished) return;
            finished = true;
            clearTimeout(imageTimer);
            imageTimers.delete(imageTimer);
            if (live()) {
              if (success) { job.card.dataset.state = 'ready'; job.status.textContent = '离线图表'; }
              else job.fail('图表图像无法显示；请查看源码。');
            }
            if (!success) { URL.revokeObjectURL(blob); blobs.delete(blob); image.remove(); }
          };
          const imageTimer = setTimeout(() => finish(false), 4000);
          imageTimers.add(imageTimer);
          image.addEventListener('load', () => finish(true), { once: true });
          image.addEventListener('error', () => finish(false), { once: true });
          image.src = blob;
          job.surface.replaceChildren(image);
        } catch (error) {
          if (!live()) return;
          job.fail('图表无法渲染：' + String(error.message || '请检查图表语法。').slice(0, 180));
        }
      }
    }
  };
}
