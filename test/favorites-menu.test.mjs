import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const directory = await readFile(new URL('../directory-studio.src.js', import.meta.url), 'utf8');
const helpers = (await Promise.all(['directory-model.src.js', 'favorites-store.src.js', 'favorites-menu.src.js'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const favorite = label => ({ href: 'file:///C:/' + label + '/', label });
function fixture() {
  let root, document;
  const focusLog = [], created = [], timers = new Map(), windowListeners = new Map(), mutations = [], prompts = [];
  let timerId = 0;
  const host = {};
  const event = (key, path = [], extra = {}) => ({ key, target: host, prevented: false, stopped: false, composedPath: () => path, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
  const window = {
    innerWidth: 800, innerHeight: 600,
    addEventListener(type, callback) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(callback); },
    removeEventListener(type, callback) { windowListeners.get(type)?.delete(callback); },
    emit(type, value) { for (const callback of [...windowListeners.get(type) || []]) callback(value); }
  };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.attributes = new Map(); this.listeners = new Map(); this.dataset = {}; this.style = {}; this.className = ''; this.textContent = ''; this.disabled = false; this.tabIndex = 0; }
    get isConnected() { return this === root || !!this.parentElement?.isConnected; }
    get classList() { return { contains: value => this.className.split(/\s+/).includes(value) }; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    remove() { if (root.activeElement && this.contains(root.activeElement)) root.activeElement = null; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    replaceChildren(...nodes) { if (root.activeElement && this.contains(root.activeElement)) root.activeElement = null; for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    matches(selector) { if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); if (selector.startsWith('[role=')) return this.getAttribute('role') === selector.slice(6, -1).replaceAll('"', ''); return this.tagName.toLowerCase() === selector; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { const result = []; for (const node of this.children) { if (node.matches(selector)) result.push(node); result.push(...node.querySelectorAll(selector)); } return result; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return this.classList.contains('favorite-menu') ? { width: 184, height: 150 } : { right: 220, top: 100, bottom: 128, width: 28, height: 28 }; }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    emit(type, value = event(undefined, [this])) { for (const callback of [...this.listeners.get(type) || []]) callback(value); return value; }
    click() { this.emit('click'); }
    focus() { if (this.disabled) return; root.activeElement = this; document.activeElement = host; focusLog.push(this); const path = [this]; let parent = this.parentElement; while (parent) { path.push(parent); parent = parent.parentElement; } window.emit('focusin', event(undefined, [...path, host, window])); }
  }
  root = new Element('root'); root.activeElement = null;
  document = { activeElement: null, createElement(tag) { const node = new Element(tag); created.push(node); return node; } };
  const element = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const favoritesHost = element('section', 'favorites'), favoriteButton = element('button'), search = element('input');
  root.append(favoritesHost, favoriteButton, search);
  const context = vm.createContext({
    URL, root, window, document, shadow: root, favoritesHost, favoriteButton, currentURL: new URL('file:///C:/A/'),
    favorites: [favorite('A'), favorite('B'), favorite('C')], element,
    link(text, href, className) { const node = element('a', className, text); node.href = href; return node; },
    icon() { return element('svg', 'icon'); },
    button(label) { const node = element('button'); node.setAttribute('aria-label', label); return node; },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); }
  });
  new vm.Script(helpers).runInContext(context);
  context.favoritesMenu = context.directoryStudioCreateFavoritesMenu({
    root, getFavorites: () => context.favorites,
    changeFavorite(intent) { mutations.push(intent); },
    renameLabel(item) { prompts.push(item); return 'Renamed label'; }
  });
  const start = directory.indexOf('    function renderFavorites()');
  const end = directory.indexOf('    const local = ', start);
  new vm.Script(directory.slice(start, end)).runInContext(context);
  const render = items => { if (items) context.favorites = items; context.renderFavorites(); };
  const menu = () => root.querySelector('.favorite-menu');
  const rows = () => favoritesHost.querySelectorAll('.favorite-row');
  const more = index => rows()[index].querySelector('button');
  const key = value => menu().emit('keydown', event(value, [root.activeElement, menu(), root, host]));
  return { context, root, document, window, event, menu, rows, more, key, render, search, favoriteButton, created, mutations, prompts, focusLog, windowListeners, timers, host,
    flushTimers() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    listenerCount() { return [...windowListeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
  };
}

test('compact rows retain native folder anchors, one more button, current-folder semantics and ellipsis', () => {
  const f = fixture(); f.render();
  assert.equal(f.menu(), null);
  for (const row of f.rows()) {
    assert.equal(row.children.length, 2); assert.equal(row.querySelectorAll('button').length, 1);
    const anchor = row.querySelector('a');
    assert.equal(anchor.href, row.dataset.href); assert.equal(anchor.title, row.dataset.href);
    assert.ok(anchor.querySelector('svg')); assert.ok(anchor.querySelector('.favorite-label'));
    assert.equal(anchor.listeners.size, 0, 'native click/middle-click/contextmenu must not be intercepted');
    assert.equal(row.querySelector('button').getAttribute('aria-haspopup'), 'menu');
    assert.equal(row.querySelector('button').tabIndex, 0);
  }
  assert.equal(f.rows()[0].querySelector('a').getAttribute('aria-current'), 'page');
  assert.equal(f.rows()[1].querySelector('a').getAttribute('aria-current'), null);
  assert.match(directory, /height:36px/); assert.match(directory, /text-overflow:ellipsis/);
  assert.match(directory, /\.favorite-row:focus-within \.favorite-more/);
  assert.match(directory, /@media\(hover:none\),\(pointer:coarse\)\{\.favorite-more\{opacity:1/);
});

test('menu is lazy, singular, boundary-aware and removes all activation listeners on close', () => {
  const f = fixture(); f.render();
  assert.equal(f.created.filter(node => node.getAttribute('role') === 'menu').length, 0);
  f.more(0).click();
  const first = f.menu(); const items = first.querySelectorAll('[role="menuitem"]');
  assert.equal(items.length, 4); assert.equal(items[1].disabled, true); assert.equal(items[2].disabled, false);
  assert.equal(f.more(0).getAttribute('aria-expanded'), 'true'); assert.equal(f.listenerCount(), 4);
  f.more(2).click();
  assert.equal(first.isConnected, false); assert.equal(f.root.querySelectorAll('.favorite-menu').length, 1);
  assert.equal(f.menu().querySelectorAll('[role="menuitem"]')[2].disabled, true);
  f.context.favoritesMenu.dispose();
  assert.equal(f.menu(), null); assert.equal(f.listenerCount(), 0); assert.equal(f.more(2).getAttribute('aria-expanded'), 'false');
});

test('shadow-retargeted inside pointer events stay open while outside pointer/focus dismiss without stealing focus', () => {
  const f = fixture(); f.render(); f.more(0).click();
  const menu = f.menu(), item = menu.querySelector('button');
  f.window.emit('pointerdown', f.event(undefined, [item, menu, f.root, f.host]));
  assert.equal(f.menu(), menu, 'event.target is host, but composedPath identifies the actual inside click');
  const focused = f.focusLog.length;
  f.window.emit('pointerdown', f.event(undefined, [f.search, f.root, f.host]));
  assert.equal(f.menu(), null); assert.equal(f.focusLog.length, focused);
  f.search.focus(); assert.equal(f.root.activeElement, f.search);
  f.more(0).click(); f.search.focus();
  assert.equal(f.menu(), null); assert.equal(f.root.activeElement, f.search);
});

test('menu keyboard opens by Enter/Space, skips disabled items, wraps and handles Home/End/Escape/Tab', () => {
  const f = fixture(); f.render();
  for (const key of ['Enter', ' ']) {
    const event = f.more(0).emit('keydown', f.event(key));
    assert.equal(event.prevented, true); assert.ok(f.menu()); f.context.favoritesMenu.close();
  }
  f.more(0).emit('keydown', f.event('ArrowDown'));
  const items = f.menu().querySelectorAll('[role="menuitem"]');
  assert.equal(f.root.activeElement, items[0]);
  f.key('ArrowDown'); assert.equal(f.root.activeElement, items[2]);
  f.key('End'); assert.equal(f.root.activeElement, items[3]);
  f.key('ArrowDown'); assert.equal(f.root.activeElement, items[0]);
  f.key('ArrowUp'); assert.equal(f.root.activeElement, items[3]);
  f.key('Home'); assert.equal(f.root.activeElement, items[0]);
  f.key('Escape'); assert.equal(f.menu(), null); assert.equal(f.root.activeElement, f.more(0));
  f.more(0).click(); const tab = f.key('Tab'); assert.equal(tab.prevented, false);
  f.search.focus(); f.flushTimers(); assert.equal(f.root.activeElement, f.search); assert.equal(f.menu(), null);
  f.more(0).emit('keydown', f.event('ArrowUp', [], { altKey: true })); assert.equal(f.menu(), null);
});

test('menu actions resolve latest labels and pass stable href intents even when ordering changes', () => {
  const f = fixture(); f.render(); f.more(1).click();
  f.context.favorites = [favorite('X'), favorite('A'), { ...favorite('B'), label: 'Latest label' }];
  f.menu().querySelectorAll('[role="menuitem"]')[0].click();
  assert.equal(f.prompts[0].label, 'Latest label');
  assert.equal(f.mutations[0].href, favorite('B').href); assert.equal(f.mutations[0].label, 'Renamed label');
  f.render(); f.more(2).click(); f.menu().querySelectorAll('[role="menuitem"]')[1].click();
  const intent = f.mutations[1]; assert.equal(intent.type, 'move'); assert.equal(intent.href, favorite('B').href); assert.equal(intent.direction, -1);
  const next = f.context.directoryStudioFavoriteIntent(f.context.favorites, intent);
  assert.deepEqual(Array.from(next, item => item.href), [favorite('X').href, favorite('B').href, favorite('A').href]);
});

test('stale detached menu events never act on a newly opened favorite', () => {
  const f = fixture(); f.render(); f.more(0).click();
  const stale = f.menu().querySelectorAll('[role="menuitem"]')[3];
  f.more(1).click(); stale.click();
  assert.equal(f.mutations.length, 0); assert.equal(f.more(1).getAttribute('aria-expanded'), 'true');
});

test('remote rerender closes menus and restores only existing favorites focus, never search focus', () => {
  const f = fixture(); f.render(); f.search.focus();
  const before = f.focusLog.length;
  f.render([favorite('X'), favorite('A'), favorite('B')]);
  assert.equal(f.root.activeElement, f.search); assert.equal(f.focusLog.length, before);
  f.more(1).click();
  f.render([favorite('X'), favorite('B')]);
  assert.equal(f.menu(), null); assert.equal(f.root.activeElement, f.more(1)); assert.equal(f.listenerCount(), 0);
  f.more(1).click(); f.render([]);
  assert.equal(f.root.activeElement, f.favoriteButton); assert.equal(f.menu(), null);
});

test('viewport placement is clamped and scroll/resize/original/pagehide cleanup cannot leave orphan menus', () => {
  const f = fixture();
  const position = f.context.directoryStudioFavoriteMenuPosition({ right: 798, top: 580, bottom: 600 }, { width: 184, height: 150 }, { width: 800, height: 600 });
  assert.ok(position.left >= 8 && position.left + 184 <= 792); assert.ok(position.top >= 8 && position.top + 150 <= 592);
  f.render();
  for (const type of ['scroll', 'resize']) { f.more(0).click(); f.window.emit(type, f.event()); assert.equal(f.menu(), null); assert.equal(f.listenerCount(), 0); }
  assert.match(directory, /function setOriginal\(original\)\s*\{\s*state\.original = original;\s*if \(imageViewer\) imageViewer\.close\(false\);\s*favoritesMenu\.close\(\)/);
  assert.match(directory, /addEventListener\('pagehide', event => \{\s*favoritesMenu\.close\(\)/);
});
