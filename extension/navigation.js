import { localURL, fileKind } from './model.js';

export function studioLinkTarget(input, studioURL) {
  const local = localURL(input);
  if (local) return local;
  try {
    const url = new URL(input);
    const studio = new URL(studioURL);
    if (url.protocol !== studio.protocol || url.host !== studio.host ||
        url.pathname !== studio.pathname || url.search || url.username || url.password) return null;
    const href = localURL(decodeURIComponent(url.hash.slice(1)));
    return href && fileKind(href) ? href : null;
  } catch {
    return null;
  }
}

export function prepareStudioLink(link, studioURL) {
  if (link.classList.contains('iv-original') || link.hasAttribute('download')) return;
  const href = localURL(link.href);
  if (!href || !fileKind(href)) return;
  link.dataset.studioFragment = String(Boolean(new URL(link.href).hash));
  // Native middle-click and context-menu actions must stay on the internal route too.
  link.href = studioURL + '#' + encodeURIComponent(href);
}
