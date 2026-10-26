(() => {
  if (window.top !== window.self || location.protocol !== 'file:') return;
  const path = location.pathname;
  if (
    !path.endsWith('/') &&
    !/\.(?:txt|log|csv|tsv|env|md|markdown|jsonc?|[cm]?js|jsx|tsx?|css|scss|ya?ml|toml|ini|cfg|conf|properties|pyw?|rs|go|c|h|[ch]pp|cc|cxx|hxx|java|cs|sh|bash|zsh|ps1|psm1|psd1|sql|bat|cmd|xml|jpe?g|png|gif|webp|avif|bmp|ico|svg)$/i.test(
      path
    )
  )
    return;
  // No unconditional hiding: paused/bypassed files must remain immediately usable.
  try {
    chrome.runtime.sendMessage({ type: 'capture', href: location.href }).catch(() => {});
  } catch {
    /* Failure leaves native page intact. */
  }
})();
