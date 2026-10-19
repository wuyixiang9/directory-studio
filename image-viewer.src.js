function directoryStudioIsImage(entry) {
  return !entry.isDirectory && /\.(?:jpe?g|png|gif|webp|avif|bmp|ico|svg)$/i.test(entry.name);
}

function directoryStudioImageSequence(entries) {
  return entries.filter(directoryStudioIsImage).map(entry => ({ name: entry.name, href: entry.href }));
}

function directoryStudioImageWindow(length, index) {
  return { start: Math.max(0, index - 10), end: Math.min(length, index + 11) };
}

function directoryStudioImageFit(width, height, viewportWidth, viewportHeight, rotation) {
  if (!(width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0)) return 1;
  const sideways = Math.abs(rotation % 180) === 90;
  return Math.min(1, viewportWidth / (sideways ? height : width), viewportHeight / (sideways ? width : height));
}

function directoryStudioImageClick(event) {
  return !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

function directoryStudioImagePath(href) {
  const url = new URL(href);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch (_) { path = url.pathname; }
  if (url.hostname) return '\\\\' + url.hostname + path.replaceAll('/', '\\');
  return /^\/[a-z]:\//i.test(path) ? path.slice(1).replaceAll('/', '\\') : path;
}

function directoryStudioImageMenuPosition(anchor, menu, bounds) {
  const margin = 8, gap = 6;
  const minLeft = bounds.left + margin, minTop = bounds.top + margin;
  const maxLeft = Math.max(minLeft, bounds.right - menu.width - margin);
  const maxTop = Math.max(minTop, bounds.bottom - menu.height - margin);
  const left = anchor.left + menu.width <= bounds.right - margin ? anchor.left : anchor.right - menu.width;
  const above = anchor.top - menu.height - gap, below = anchor.bottom + gap;
  const top = above >= minTop || below + menu.height > bounds.bottom - margin ? above : below;
  return { left: Math.max(minLeft, Math.min(left, maxLeft)), top: Math.max(minTop, Math.min(top, maxTop)) };
}

function directoryStudioCreateImageViewer({ root, restoreFocus }) {
  let session = null;
  let disposed = false;
  const make = (tag, className = '', text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function close(focus = true) {
    const old = session;
    if (!old) return;
    session = null;
    old.live = false;
    old.releaseLoad();
    old.releaseCopy();
    old.releaseThumbs();
    old.releasePointer();
    old.cleanup.forEach(fn => fn());
    if (old.dialog.open) old.dialog.close();
    old.dialog.remove();
    old.style.remove();
    if (focus) restoreFocus(old.items[old.index].href);
  }
  function open(sequence, href) {
    if (disposed) return false;
    const index = sequence.findIndex(item => item.href === href);
    if (index < 0 || typeof document.createElement('dialog').showModal !== 'function') return false;
    close(false);
    const s = {
      items: sequence.map(item => ({ ...item })), index, rotations: new Map(), live: true,
      cleanup: [], releaseLoad() {}, releaseCopy() {}, releaseThumbs() {}, releasePointer() {}, scale: 1, panX: 0, panY: 0,
      mode: 'fit', loaded: false, generation: 0, copying: false
    };
    session = s;
    const on = (target, type, callback, options) => {
      target.addEventListener(type, callback, options);
      s.cleanup.push(() => target.removeEventListener(type, callback, options));
    };
    const style = make('style');
    s.style = style;
    style.textContent = `
      .image-viewer{width:calc(100% - 32px);max-width:min(1800px,100%);height:calc(100dvh - 32px);max-height:none;margin:auto;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--text);font:inherit;box-shadow:var(--shadow);overflow:hidden}
      .image-viewer::backdrop{background:#0009}.image-viewer[open]{display:flex;flex-direction:column}.iv-header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--surface)}.iv-title{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.iv-count{color:var(--muted);white-space:nowrap;font:12px Consolas,monospace}.iv-tools{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);flex-shrink:0;align-items:center;gap:10px 18px;padding:10px 12px;border-top:1px solid var(--line);background:var(--surface)}
      .iv-tool-primary{grid-column:2;display:flex;align-items:center;gap:10px 18px;max-width:100%}.iv-tool-group{display:flex;align-items:center;max-width:100%;padding-right:18px;border-right:1px solid var(--line)}.iv-tool-primary>.iv-tool-group:last-child{padding-right:0;border-right:0}.iv-tools>.iv-tool-group{grid-column:3;justify-self:end;padding-right:0;border-right:0}.iv-tool-controls{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
      @media(max-width:1100px){.iv-tools{grid-template-columns:minmax(0,1fr)}.iv-tool-primary{grid-column:1;width:100%;justify-content:center;flex-wrap:wrap}.iv-tools>.iv-tool-group{grid-column:1}}
      .iv-button,.iv-original,.iv-copy summary{border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--text);padding:6px 10px;font:inherit;cursor:pointer;white-space:nowrap}.iv-button:enabled:hover,.iv-original:hover,.iv-copy summary:hover{background:var(--wash)}.iv-button:focus-visible,.iv-original:focus-visible,.iv-copy summary:focus-visible,.iv-thumb:focus-visible,.iv-stage:focus-visible{outline:3px solid var(--blue);outline-offset:-3px}.iv-button:disabled{opacity:.4;cursor:default}
      .iv-body{display:flex;flex:1;min-height:0}.iv-stage{position:relative;flex:1;min-width:0;overflow:hidden;touch-action:none;background:repeating-conic-gradient(var(--surface) 0% 25%,var(--bg) 0% 50%) 0 0/24px 24px;cursor:grab}.iv-stage:active{cursor:grabbing}.iv-image{position:absolute;top:50%;left:50%;max-width:none;max-height:none;user-select:none;pointer-events:none;transform-origin:center}.iv-sidebar{width:220px;flex-shrink:0;overflow:auto;border-left:1px solid var(--line);background:var(--surface);padding:8px;overscroll-behavior:contain}.iv-sidebar[hidden]{display:none}.iv-thumb{display:flex;align-items:center;gap:8px;width:100%;height:76px;overflow:hidden;margin-bottom:6px;padding:4px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--text);text-align:left;cursor:pointer}.iv-thumb[aria-current=true]{border:2px solid var(--blue);background:var(--wash)}.iv-thumb img{width:64px;height:64px;object-fit:contain;flex-shrink:0}.iv-thumb span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.iv-status{min-height:32px;padding:6px 14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);overflow-wrap:anywhere}.iv-copy{position:relative}.iv-copy summary{list-style:none}.iv-copy-panel{position:fixed;z-index:3;display:grid;gap:5px;width:max-content;max-width:calc(100% - 16px);overflow:auto;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);box-shadow:var(--shadow)}.iv-copy-panel .iv-button{text-align:left;white-space:normal}
      @media(max-width:700px){.image-viewer{width:100%;max-width:100%;height:100dvh;border-radius:0;border:0}.iv-header{padding:8px}.iv-tools{padding:8px 6px;gap:10px 16px}.iv-tool-primary{gap:10px 16px}.iv-tool-group{padding-right:0;border-right:0}.iv-tool-controls{gap:4px}.iv-button,.iv-original,.iv-copy summary{font-size:12px;padding:6px}.iv-body{flex-direction:column}.iv-sidebar{width:auto;height:100px;display:flex;gap:6px;border-left:0;border-top:1px solid var(--line)}.iv-thumb{width:100px;height:78px;flex-shrink:0;flex-direction:column;gap:0}.iv-thumb img{width:50px;height:50px}.iv-thumb span{max-width:90px;font-size:10px}.iv-count{font-size:10px}}
    `;
    const dialog = make('dialog', 'image-viewer'); s.dialog = dialog;
    dialog.setAttribute('aria-label', '图片查看器');
    const header = make('header', 'iv-header');
    const title = make('span', 'iv-title'), count = make('span', 'iv-count');
    const tools = make('div', 'iv-tools'); tools.setAttribute('aria-label', '图片操作');
    const primary = make('div', 'iv-tool-primary'); tools.append(primary);
    const group = (label, parent = primary) => {
      const container = make('div', 'iv-tool-group'); container.setAttribute('role', 'group'); container.setAttribute('aria-label', label);
      const controls = make('div', 'iv-tool-controls');
      container.append(controls); parent.append(container);
      return controls;
    };
    const browse = group('浏览'), scaling = group('缩放'), rotating = group('旋转'), files = group('文件', tools);
    const control = (label, action, parent = tools) => {
      const button = make('button', 'iv-button', label); button.type = 'button';
      button.setAttribute('aria-label', label); on(button, 'click', action); parent.append(button); return button;
    };
    const closeButton = control('关闭', () => close(), header);
    header.prepend(title, count);
    const previous = control('上一张', () => select(s.index - 1), browse);
    const next = control('下一张', () => select(s.index + 1), browse);
    const minus = control('缩小', () => zoom(1 / 1.25), scaling);
    const plus = control('放大', () => zoom(1.25), scaling);
    const fitButton = control('适应窗口', () => fit(), scaling);
    const actualButton = control('100%', () => { s.mode = 'manual'; s.scale = 1; s.panX = s.panY = 0; transform(); }, scaling);
    const left = control('向左旋转', () => rotate(-90), rotating);
    const right = control('向右旋转', () => rotate(90), rotating);
    const original = make('a', 'iv-original', '打开原图'); original.target = '_blank'; original.rel = 'noopener noreferrer'; files.append(original);
    const copy = make('details', 'iv-copy'); const summary = make('summary', '', '复制');
    const copyPanel = make('div', 'iv-copy-panel'); copy.append(summary, copyPanel); files.append(copy);
    summary.setAttribute('aria-expanded', 'false');
    function closeCopyMenu(focus = false) {
      if (!copy.open) return;
      copy.open = false; summary.setAttribute('aria-expanded', 'false');
      if (focus) summary.focus();
    }
    function positionCopyMenu() {
      if (!copy.open || !s.live) return;
      const rect = dialog.getBoundingClientRect(), viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0, viewportTop = viewport?.offsetTop || 0;
      const bounds = {
        left: Math.max(rect.left, viewportLeft), top: Math.max(rect.top, viewportTop),
        right: Math.min(rect.right, viewportLeft + (viewport?.width || document.documentElement.clientWidth)),
        bottom: Math.min(rect.bottom, viewportTop + (viewport?.height || document.documentElement.clientHeight))
      };
      copyPanel.style.maxWidth = Math.max(0, bounds.right - bounds.left - 16) + 'px';
      copyPanel.style.maxHeight = Math.max(0, bounds.bottom - bounds.top - 16) + 'px';
      const position = directoryStudioImageMenuPosition(summary.getBoundingClientRect(), copyPanel.getBoundingClientRect(), bounds);
      copyPanel.style.left = position.left + 'px'; copyPanel.style.top = position.top + 'px';
    }
    on(summary, 'click', event => {
      event.preventDefault();
      if (copy.open) closeCopyMenu();
      else { copy.open = true; summary.setAttribute('aria-expanded', 'true'); positionCopyMenu(); }
    });
    on(copy, 'toggle', () => { summary.setAttribute('aria-expanded', String(copy.open)); if (copy.open) positionCopyMenu(); });
    on(dialog, 'pointerdown', event => { if (!event.composedPath().includes(copy)) closeCopyMenu(); });
    on(window, 'scroll', event => { if (!event.composedPath().includes(copyPanel)) closeCopyMenu(); }, true);
    const imageCopy = control('复制图片（原图，未旋转）', () => copyValue('image'), copyPanel);
    control('复制路径', () => copyValue('path'), copyPanel);
    control('复制文件名', () => copyValue('name'), copyPanel);
    const toggle = control('缩略图', () => {
      sidebar.hidden = !sidebar.hidden;
      toggle.setAttribute('aria-expanded', String(!sidebar.hidden));
      if (!sidebar.hidden) thumbnails(); else s.releaseThumbs();
      if (s.mode === 'fit') fit();
    }, browse);
    toggle.setAttribute('aria-expanded', 'true');
    const body = make('div', 'iv-body');
    const stage = make('div', 'iv-stage'); stage.tabIndex = 0; stage.setAttribute('aria-label', '图片画布：滚轮缩放，拖动平移');
    const sidebar = make('nav', 'iv-sidebar'); sidebar.setAttribute('aria-label', '相邻图片');
    const status = make('div', 'iv-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    body.append(stage, sidebar); dialog.append(header, body, tools, status); root.append(style, dialog);
    let image = null;
    const current = () => s.items[s.index];
    const alive = (generation = s.generation) => session === s && s.live && generation === s.generation;
    const message = text => { if (alive()) status.textContent = text; };
    const rotation = () => s.rotations.get(current().href) || 0;
    function transform() {
      if (!s.loaded || !image) return;
      image.style.transform = `translate(-50%,-50%) translate(${s.panX}px,${s.panY}px) rotate(${rotation()}deg) scale(${s.scale})`;
      count.textContent = `${s.index + 1} / ${s.items.length} | ${image.naturalWidth} x ${image.naturalHeight} | ${Math.round(s.scale * 100)}%`;
    }
    function fit() {
      s.mode = 'fit'; s.panX = s.panY = 0;
      if (s.loaded) {
        s.scale = directoryStudioImageFit(image.naturalWidth, image.naturalHeight, Math.max(1, stage.clientWidth - 32), Math.max(1, stage.clientHeight - 32), rotation());
        transform();
      }
    }
    function zoom(factor) {
      if (!s.loaded) return;
      s.mode = 'manual'; s.scale = Math.min(32, Math.max(0.01, s.scale * factor)); transform();
    }
    function rotate(delta) {
      if (!s.loaded) return;
      s.releasePointer();
      s.rotations.set(current().href, (rotation() + delta + 360) % 360);
      s.panX = s.panY = 0;
      if (s.mode === 'fit') fit(); else transform();
    }
    function thumbnails() {
      s.releaseThumbs(); sidebar.replaceChildren();
      if (sidebar.hidden) return;
      const generation = s.generation;
      const { start, end } = directoryStudioImageWindow(s.items.length, s.index);
      const jobs = [], pending = [], active = new Set();
      let stopped = false, observer;
      function pump() {
        if (stopped || !alive(generation)) return;
        while (active.size < 2 && pending.length) {
          const job = pending.shift();
          if (job.started || !job.visible) continue;
          job.started = true; active.add(job);
          if (observer) observer.unobserve(job.button);
          job.timer = setTimeout(() => finish(job, true), 15000);
          job.img.onload = () => finish(job, false);
          job.img.onerror = () => finish(job, true);
          job.img.src = job.href;
        }
      }
      function finish(job, failed) {
        clearTimeout(job.timer); job.img.onload = job.img.onerror = null;
        if (failed) { job.img.removeAttribute('src'); job.img.alt = '缩略图无法加载'; }
        active.delete(job); pump();
      }
      if (typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver(records => {
          for (const record of records) {
            const job = jobs.find(value => value.button === record.target);
            if (!job || job.started) continue;
            job.visible = record.isIntersecting;
            if (job.visible && !pending.includes(job)) pending.push(job);
          }
          pump();
        }, { root: sidebar });
      }
      for (let i = start; i < end; i++) {
        const item = s.items[i];
        const button = make('button', 'iv-thumb'); button.type = 'button'; button.title = item.name;
        button.setAttribute('aria-label', `${i + 1}: ${item.name}`); button.setAttribute('aria-current', String(i === s.index));
        const thumb = make('img'); thumb.alt = ''; thumb.decoding = 'async';
        button.append(thumb, make('span', '', item.name));
        const handler = () => {
          if (!alive(generation)) return;
          select(i);
          const selected = [...sidebar.children].find(node => node.getAttribute('aria-current') === 'true');
          if (selected) selected.focus({ preventScroll: true });
        };
        button.addEventListener('click', handler);
        const job = { img: thumb, button, href: item.href, started: false, handler }; jobs.push(job); sidebar.append(button);
        if (observer) observer.observe(button);
      }
      const selected = jobs.find(job => job.href === current().href);
      if (selected) {
        selected.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (!observer) { selected.visible = true; pending.push(selected); pump(); }
      }
      s.releaseThumbs = () => {
        stopped = true; if (observer) observer.disconnect(); pending.length = 0;
        for (const job of jobs) {
          clearTimeout(job.timer); job.img.onload = job.img.onerror = null; job.img.removeAttribute('src');
          job.button.removeEventListener('click', job.handler);
        }
        active.clear();
      };
    }
    function select(index) {
      if (!alive() || index < 0 || index >= s.items.length) return;
      s.releaseLoad(); s.releaseCopy(); s.releasePointer();
      s.index = index; s.generation++; s.loaded = false; s.copying = false;
      s.mode = 'fit'; s.panX = s.panY = 0; copy.open = false;
      const generation = s.generation;
      title.textContent = current().name; title.title = current().name; original.href = current().href;
      count.textContent = `${index + 1} / ${s.items.length}`;
      previous.disabled = index === 0; next.disabled = index === s.items.length - 1;
      for (const button of [fitButton, actualButton, minus, plus, left, right, imageCopy]) button.disabled = true;
      message('正在加载图片…');
      const loading = make('img', 'iv-image'); loading.alt = current().name; loading.draggable = false; loading.decoding = 'async';
      image = loading; loading.hidden = true; stage.replaceChildren(loading);
      let timer, finished = false;
      const fail = () => {
        if (!alive(generation) || finished) return;
        finished = true;
        clearTimeout(timer); loading.onload = loading.onerror = null; loading.removeAttribute('src');
        message('无法显示这张图片。请尝试打开原图，或继续查看下一张。');
      };
      loading.onload = () => {
        if (!alive(generation) || finished) return;
        clearTimeout(timer);
        if (!loading.naturalWidth || !loading.naturalHeight) { fail(); return; }
        finished = true;
        loading.onload = loading.onerror = null; loading.hidden = false; s.loaded = true;
        for (const button of [fitButton, actualButton, minus, plus, left, right, imageCopy]) button.disabled = false;
        fit(); message('滚轮缩放，拖动平移；R 向右旋转，Shift+R 向左旋转。复制图片使用原始像素，不包含查看时的旋转。');
      };
      loading.onerror = fail;
      timer = setTimeout(fail, 30000);
      s.releaseLoad = () => { finished = true; clearTimeout(timer); loading.onload = loading.onerror = null; loading.removeAttribute('src'); };
      loading.src = current().href;
      thumbnails();
    }
    async function copyValue(kind) {
      if (!alive() || s.copying) return;
      if (kind === 'image' && !s.loaded) return;
      const generation = s.generation, item = current();
      s.copying = true; imageCopy.disabled = true; copy.open = false; message('正在复制…');
      try {
        if (kind === 'image') {
          if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof ClipboardItem !== 'function') throw new Error('当前浏览器或页面不支持复制图片');
          const width = image.naturalWidth, height = image.naturalHeight;
          if (width > 16384 || height > 16384 || width * height > 16777216) throw new Error('图片超出复制上限（1600 万像素，单边不超过 16384 像素）');
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          let blob;
          try {
            const context = canvas.getContext('2d');
            if (!context) throw new Error('当前页面无法创建图片画布');
            context.drawImage(image, 0, 0);
            blob = await new Promise((resolve, reject) => {
              let complete = false;
              const finish = (value, error) => {
                if (complete) return;
                complete = true; clearTimeout(timer); canvas.width = canvas.height = 0;
                if (error) reject(error); else resolve(value);
              };
              const timer = setTimeout(() => finish(null, new Error('PNG 编码超时')), 15000);
              s.releaseCopy = () => finish(null);
              try { canvas.toBlob(value => finish(value, value ? null : new Error('PNG 编码失败')), 'image/png'); }
              catch (error) { finish(null, error); }
            });
          } finally { canvas.width = canvas.height = 0; if (alive(generation)) s.releaseCopy = () => {}; }
          if (!alive(generation)) return;
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        } else {
          const value = kind === 'path' ? directoryStudioImagePath(item.href) : item.name;
          if (!alive(generation)) return;
          if (typeof GM_setClipboard === 'function') await GM_setClipboard(value, 'text');
          else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') await navigator.clipboard.writeText(value);
          else throw new Error('当前页面不支持复制文本');
        }
        if (alive(generation)) message(kind === 'image' ? '已复制图片（原图，未旋转）。' : kind === 'path' ? '已复制路径。' : '已复制文件名。');
      } catch (error) {
        if (alive(generation)) message(`复制失败：${error.message || '剪贴板权限或本地文件安全限制'}。未改为复制其他内容。`);
      } finally {
        if (alive(generation)) { s.copying = false; imageCopy.disabled = !s.loaded; }
      }
    }
    let pointer = null;
    function releasePointer() {
      if (pointer && stage.hasPointerCapture(pointer.id)) stage.releasePointerCapture(pointer.id);
      pointer = null;
    }
    s.releasePointer = releasePointer;
    on(stage, 'pointerdown', event => {
      if (!s.loaded || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const sideways = rotation() % 180 !== 0;
      if ((sideways ? image.naturalHeight : image.naturalWidth) * s.scale <= stage.clientWidth &&
          (sideways ? image.naturalWidth : image.naturalHeight) * s.scale <= stage.clientHeight) return;
      releasePointer(); pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: s.panX, panY: s.panY };
      stage.setPointerCapture(event.pointerId); event.preventDefault();
    });
    on(stage, 'pointermove', event => {
      if (!pointer || event.pointerId !== pointer.id) return;
      s.panX = pointer.panX + event.clientX - pointer.x; s.panY = pointer.panY + event.clientY - pointer.y; transform();
    });
    on(stage, 'pointerup', releasePointer); on(stage, 'pointercancel', releasePointer);
    on(stage, 'lostpointercapture', () => { pointer = null; });
    on(stage, 'wheel', event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault(); zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    on(dialog, 'cancel', event => { event.preventDefault(); close(); });
    on(dialog, 'close', () => { if (alive()) close(); });
    on(dialog, 'keydown', event => {
      if (!alive() || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.composedPath()[0];
      if (target && (target.matches('input,textarea,select') || target.isContentEditable)) return;
      if (event.key === 'Escape' && copy.open) { event.preventDefault(); event.stopPropagation(); closeCopyMenu(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (!event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault(); select(s.index + (event.key === 'ArrowLeft' ? -1 : 1));
      } else if (event.key.toLowerCase() === 'r') { event.preventDefault(); rotate(event.shiftKey ? -90 : 90); }
      event.stopPropagation();
    });
    on(window, 'resize', () => { closeCopyMenu(); if (s.mode === 'fit') fit(); });
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => { if (alive() && s.mode === 'fit') fit(); });
      observer.observe(stage); s.cleanup.push(() => observer.disconnect());
    }
    try { dialog.showModal(); select(index); closeButton.focus(); }
    catch (_) { close(false); return false; }
    return true;
  }
  return { open, close, get isOpen() { return !!session; }, dispose() { disposed = true; close(false); } };
}
