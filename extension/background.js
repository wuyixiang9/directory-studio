import { localURL, fileKind } from './model.js';

// All listeners are registered synchronously so MV3 can wake a stopped worker.
const tabJobs = new Map();
export async function redirect(tabId, input) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  const href = localURL(input);
  if (!href || !fileKind(href)) {
    tabJobs.delete(tabId);
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
    await chrome.tabs.update(tabId, {
      url: chrome.runtime.getURL('studio.html') + '#' + encodeURIComponent(href)
    });
    return true;
  } catch {
    return false;
  } finally {
    if (tabJobs.get(tabId) === job) tabJobs.delete(tabId);
  }
}
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) void redirect(details.tabId, details.url);
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) void redirect(id, change.url);
});
chrome.tabs.onRemoved.addListener((id) => {
  void chrome.storage.session.remove('native.' + id);
  tabJobs.delete(id);
});
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const ownPage =
    !sender.tab?.url?.startsWith('file:') && sender.url?.startsWith(chrome.runtime.getURL('studio.html'));
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
