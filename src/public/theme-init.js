(() => {
  let theme = 'dark';
  try {
    if (localStorage.getItem('vq-theme') === 'light') theme = 'light';
  } catch {
    // A blocked storage read still uses the default theme.
  }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]').content = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f7f8f4' : '#141716';
})();
