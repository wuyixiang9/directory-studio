// Runs before the stylesheet and before first content paint. Never reads file contents.
(() => {
  let theme;
  try {
    theme = localStorage.getItem('directory-studio.theme');
  } catch {
    /* Use OS preference. */
  }
  document.documentElement.dataset.theme =
    theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme:dark)').matches)
      ? 'dark'
      : 'light';
})();
