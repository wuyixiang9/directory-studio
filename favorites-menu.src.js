function directoryStudioFavoriteMenuPosition(anchor, menu, viewport) {
  const margin = 8;
  const left = Math.max(margin, Math.min(anchor.right - menu.width, viewport.width - menu.width - margin));
  const below = anchor.bottom + 4;
  const top = Math.max(margin, Math.min(below + menu.height <= viewport.height - margin ? below : anchor.top - menu.height - 4, viewport.height - menu.height - margin));
  return { left, top };
}
function directoryStudioCreateFavoritesMenu({ root, getFavorites, changeFavorite, renameLabel }) {
  let current = null;
  let tabTimer;
  const activeElement = () => root.activeElement || document.activeElement;
  function close(restoreFocus = false) {
    clearTimeout(tabTimer);
    if (!current) return;
    const previous = current;
    current = null;
    previous.trigger.setAttribute('aria-expanded', 'false');
    previous.trigger.parentElement?.removeAttribute('data-menu-open');
    previous.menu.remove();
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('focusin', outside, true);
    window.removeEventListener('resize', viewportChanged);
    window.removeEventListener('scroll', viewportChanged, true);
    if (restoreFocus && previous.trigger.isConnected) previous.trigger.focus({ preventScroll: true });
  }
  function outside(event) {
    if (!current) return;
    const path = event.composedPath();
    if (!path.includes(current.menu) && !path.includes(current.trigger)) close();
  }
  function viewportChanged() { close(); }
  function enabledItems() { return current ? [...current.menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled) : []; }
  function onKeydown(event) {
    if (!current) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { clearTimeout(tabTimer); tabTimer = setTimeout(() => close(), 0); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = enabledItems();
    if (!items.length) return;
    let index = items.indexOf(activeElement());
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = items.length - 1;
    else index = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index].focus();
  }
  function activate(type, direction) {
    if (!current) return;
    const href = current.href;
    const favorite = getFavorites().find(item => item.href === href);
    close(true);
    if (!favorite) return;
    if (type === 'rename') {
      const label = renameLabel(favorite);
      if (typeof label === 'string' && label.trim()) changeFavorite({ type, href, label });
    } else changeFavorite({ type, href, ...(type === 'move' ? { direction } : {}) });
  }
  function open(trigger, href, last = false) {
    close();
    const favorites = getFavorites();
    const index = favorites.findIndex(item => item.href === href);
    if (index < 0 || !trigger.isConnected) return;
    const menu = document.createElement('div');
    menu.className = 'favorite-menu'; menu.id = 'directory-studio-favorites-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '收藏管理：' + favorites[index].label);
    const actions = [
      ['重命名标签', 'rename', undefined, false],
      ['上移', 'move', -1, index === 0],
      ['下移', 'move', 1, index === favorites.length - 1],
      ['取消收藏', 'remove', undefined, false]
    ];
    for (const [label, type, direction, disabled] of actions) {
      if (type === 'remove') {
        const divider = document.createElement('div'); divider.className = 'favorite-menu-divider'; divider.setAttribute('role', 'separator'); menu.append(divider);
      }
      const item = document.createElement('button'); item.type = 'button'; item.tabIndex = -1;
      item.className = 'favorite-menu-item' + (type === 'remove' ? ' is-danger' : ''); item.textContent = label;
      item.setAttribute('role', 'menuitem'); item.disabled = disabled; item.setAttribute('aria-disabled', String(disabled));
      item.addEventListener('click', () => { if (current?.menu === menu && !item.disabled) activate(type, direction); });
      menu.append(item);
    }
    current = { menu, trigger, href };
    trigger.setAttribute('aria-expanded', 'true'); trigger.parentElement?.setAttribute('data-menu-open', 'true');
    menu.addEventListener('keydown', onKeydown);
    root.append(menu);
    const position = directoryStudioFavoriteMenuPosition(trigger.getBoundingClientRect(), menu.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = position.left + 'px'; menu.style.top = position.top + 'px';
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('focusin', outside, true);
    window.addEventListener('resize', viewportChanged);
    window.addEventListener('scroll', viewportChanged, true);
    const items = enabledItems();
    (last ? items.at(-1) : items[0])?.focus();
  }
  return {
    toggle(trigger, href) { if (current?.trigger === trigger) close(true); else open(trigger, href); },
    triggerKey(event, trigger, href) {
      if (event.altKey || event.ctrlKey || event.metaKey || !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); open(trigger, href, event.key === 'ArrowUp');
    },
    focusContext(element) { return current && current.menu.contains(element) ? { href: current.href, more: true } : null; },
    close,
    dispose: () => close()
  };
}
