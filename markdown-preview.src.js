function createStudioMarkdownRenderer(MarkdownIt, url) {
  const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 40 });
  let blocks = [];
  const defaultFence = markdown.renderer.rules.fence;
  markdown.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
    if (tokens[index].info.trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') return defaultFence(tokens, index, options, environment, renderer);
    const block = blocks.push(tokens[index].content) - 1;
    return '<section class="lts-mermaid-card" data-mermaid-index="' + block + '" aria-label="Mermaid 图表"></section>';
  };
  const safeLink = value => {
    try { return ['file:', 'http:', 'https:', 'mailto:'].includes(new URL(value, url).protocol); } catch (_) { return false; }
  };
  markdown.validateLink = safeLink;
  markdown.renderer.rules.image = (tokens, index) => '<span class="lts-image-label">' +
    markdown.utils.escapeHtml('[图片：' + (tokens[index].content || '未命名') + ' · 未加载]') + '</span>';
  markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const href = token.attrGet('href') || '';
    if (!safeLink(href)) token.attrSet('href', '#');
    else {
      const target = new URL(href, url);
      token.attrSet('href', target.href);
      if (target.protocol === 'http:' || target.protocol === 'https:') token.attrSet('target', '_blank');
    }
    token.attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
  };
  return {
    render(text) {
      blocks = [];
      const html = markdown.render(text);
      return { html, blocks: blocks.slice() };
    }
  };
}
function scheduleStudioDiagramRender(callback) {
  let canceled = false;
  let second;
  const first = requestAnimationFrame(() => {
    if (!canceled) second = requestAnimationFrame(() => { if (!canceled) callback(); });
  });
  return () => { canceled = true; cancelAnimationFrame(first); cancelAnimationFrame(second); };
}
