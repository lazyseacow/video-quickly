(() => {
  let savedTheme;
  try {
    savedTheme = localStorage.getItem('vq-theme');
  } catch {
    // The document defaults to the light scheme if storage is unavailable.
    return;
  }
  const theme = savedTheme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]').content = theme;
})();
