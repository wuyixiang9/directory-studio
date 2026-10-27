import { localURL, fileKind } from './model.js';

export const RECENT_EXTERNAL_FILES_KEY = 'recentExternalFiles';
export const RECENT_EXTERNAL_FILES_LIMIT = 15;

export function recentExternalFiles(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const input of value) {
    const href = localURL(input);
    if (!href || !['text', 'image'].includes(fileKind(href)) || seen.has(href)) continue;
    seen.add(href);
    result.push(href);
    if (result.length === RECENT_EXTERNAL_FILES_LIMIT) break;
  }
  return result;
}

export function createRecentExternalRecorder(storage) {
  let pending = Promise.resolve();
  return (input) => {
    const [href] = recentExternalFiles([input]);
    if (!href) return Promise.resolve();
    // Only the background worker writes this key; serialize all tabs' read-modify-write operations.
    pending = pending.then(async () => {
      const current = await storage.get(RECENT_EXTERNAL_FILES_KEY);
      const recent = recentExternalFiles([href, ...recentExternalFiles(current[RECENT_EXTERNAL_FILES_KEY])]);
      await storage.set({ [RECENT_EXTERNAL_FILES_KEY]: recent });
    }).catch(() => {});
    return pending;
  };
}
