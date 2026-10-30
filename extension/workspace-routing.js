export function isStudioURL(input, studioURL) {
  try {
    const url = new URL(input);
    const studio = new URL(studioURL);
    return url.protocol === studio.protocol && url.host === studio.host &&
      url.pathname === studio.pathname && !url.search;
  } catch {
    return false;
  }
}

export function createWorkspaceRouter(api) {
  const studioURL = api.runtime.getURL('studio.html');
  const queues = new Map();
  const serialized = (windowId, task) => {
    const previous = queues.get(windowId) || Promise.resolve();
    const job = previous.catch(() => {}).then(task);
    queues.set(windowId, job);
    return job.finally(() => { if (queues.get(windowId) === job) queues.delete(windowId); });
  };
  async function requestOpen(message) {
    let timer;
    try {
      return await Promise.race([
        api.runtime.sendMessage(message).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 10000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function workspaces(windowId, exclude) {
    const contexts = await api.runtime.getContexts({ contextTypes: ['TAB'], windowIds: [windowId], frameIds: [0] });
    const candidates = [];
    for (const context of contexts) {
      if (context.tabId === exclude || !context.documentId || !isStudioURL(context.documentUrl, studioURL)) continue;
      try {
        const tab = await api.tabs.get(context.tabId);
        if (tab.windowId === windowId && !tab.discarded &&
            (!tab.pendingUrl || isStudioURL(tab.pendingUrl, studioURL))) candidates.push({ tab, context });
      } catch { /* A closed tab is not a workspace. */ }
    }
    return candidates.sort((a, b) => a.tab.index - b.tab.index || a.tab.id - b.tab.id);
  }
  async function live(candidate, windowId) {
    const contexts = await api.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [candidate.tab.id],
      documentIds: [candidate.context.documentId], frameIds: [0] });
    const tab = await api.tabs.get(candidate.tab.id);
    return tab.windowId === windowId && !tab.discarded &&
      (!tab.pendingUrl || isStudioURL(tab.pendingUrl, studioURL)) &&
      contexts.some(context => context.documentId === candidate.context.documentId &&
        isStudioURL(context.documentUrl, studioURL));
  }
  return {
    open(windowId, href, exclude, current = () => true) {
      return serialized(windowId, async () => {
        try {
          for (const candidate of await workspaces(windowId, exclude)) {
            if (!await current()) return false;
            if (!await live(candidate, windowId)) continue;
            const response = await requestOpen({ type: 'workspaceOpen', href,
              recipient: candidate.context.documentId });
            if (response?.timedOut) return false;
            if (response?.opened !== true) continue;
            // Never replace a workspace URL: its own navigation preserves all dirty documents.
            if (!await live(candidate, windowId)) return false;
            await api.tabs.update(candidate.tab.id, { active: true });
            return true;
          }
        } catch { /* Failed delivery leaves the incoming tab available for the normal capture route. */ }
        return false;
      });
    },
    focus(windowId) {
      return serialized(windowId, async () => {
        try {
          for (const candidate of await workspaces(windowId)) {
            if (!await live(candidate, windowId)) continue;
            await api.tabs.update(candidate.tab.id, { active: true });
            return candidate.tab.id;
          }
        } catch { /* Opening a new workspace remains available. */ }
        const tab = await api.tabs.create({ windowId, url: studioURL });
        return tab.id;
      });
    }
  };
}
