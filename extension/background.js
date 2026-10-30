import { localURL, fileKind } from './model.js';
import { createRecentExternalRecorder } from './recent-files.js';
import { createWorkspaceRouter, isStudioURL } from './workspace-routing.js';

// All listeners are registered synchronously so MV3 can wake a stopped worker.
const tabJobs = new Map();
const recordRecentExternal = createRecentExternalRecorder(chrome.storage.local);
const workspaces = createWorkspaceRouter(chrome);
const incomingTabs = new Map();
export async function redirect(tabId, input) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  const href = localURL(input);
  if (!href || !fileKind(href)) {
    tabJobs.delete(tabId);
    incomingTabs.delete(tabId);
    return false;
  }
  const job = Symbol();
  tabJobs.set(tabId, job);
  try {
    const [allowed, settings, bypass] = await Promise.all([
      chrome.extension.isAllowedFileSchemeAccess(),
      chrome.storage.local.get('autoCapture'),
      chrome.storage.session.get('native.' + tabId)
    ]);
    const skip = bypass['native.' + tabId];
    if (
      !allowed ||
      settings.autoCapture === false ||
      (skip && skip.href === href && skip.expires > Date.now())
    )
      return false;
    // Navigation notifications may arrive after the user has already gone elsewhere.
    const tab = await chrome.tabs.get(tabId);
    const current = localURL(tab.pendingUrl || tab.url);
    if (current !== href || tabJobs.get(tabId) !== job) return false;
    const currentNavigation = async () => {
      const latest = await chrome.tabs.get(tabId);
      return tabJobs.get(tabId) === job && localURL(latest.pendingUrl || latest.url) === href;
    };
    const delivered = await workspaces.open(tab.windowId, href, tabId, currentNavigation);
    if (!await currentNavigation()) return false;
    if (delivered) {
      // Only a tab observed at creation with this exact file URL is disposable.
      // Existing tabs, restored tabs and unknown origins are never closed.
      const incoming = incomingTabs.get(tabId);
      if (incoming?.href === href && incoming.expires > Date.now()) {
        incomingTabs.delete(tabId);
        await chrome.tabs.remove(tabId).catch(() => {});
      }
    } else {
      await chrome.tabs.update(tabId, {
        url: chrome.runtime.getURL('studio.html') + '#' + encodeURIComponent(href)
      });
    }
    await recordRecentExternal(href);
    return true;
  } catch {
    return false;
  } finally {
    if (tabJobs.get(tabId) === job) {
      tabJobs.delete(tabId);
      incomingTabs.delete(tabId);
    }
  }
}
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    const incoming = incomingTabs.get(details.tabId);
    if (incoming && localURL(details.url) !== incoming.href) incomingTabs.delete(details.tabId);
    void redirect(details.tabId, details.url);
  }
});
chrome.tabs.onCreated.addListener((tab) => {
  const href = localURL(tab.pendingUrl || tab.url);
  if (href && fileKind(href)) incomingTabs.set(tab.id, { href, expires: Date.now() + 10000 });
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) void redirect(id, change.url);
});
chrome.tabs.onRemoved.addListener((id) => {
  void chrome.storage.session.remove('native.' + id);
  tabJobs.delete(id);
  incomingTabs.delete(id);
});
chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
    await workspaces.focus(windowId);
  })().catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const ownPage = isStudioURL(sender.url, chrome.runtime.getURL('studio.html'));
  if (message?.type === 'studioReady' && ownPage && sender.tab && sender.frameId === 0 && sender.documentId) {
    respond({ documentId: sender.documentId });
    return false;
  }
  if (
    message?.type === 'capture' &&
    sender.tab &&
    sender.frameId === 0 &&
    localURL(sender.url) === localURL(message.href)
  ) {
    redirect(sender.tab.id, message.href).then((captured) => respond({ captured }));
    return true;
  }
  if (message?.type === 'native' && ownPage && sender.tab && localURL(message.href)) {
    const href = localURL(message.href);
    (async () => {
      await chrome.storage.session.set({
        ['native.' + sender.tab.id]: { href, expires: Date.now() + 600000 }
      });
      await chrome.tabs.update(sender.tab.id, { url: href });
    })().then(
      () => respond({ ok: true }),
      (error) => respond({ error: String(error.message) })
    );
    return true;
  }
});
