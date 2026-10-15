// Runs before first paint so the saved theme never flashes. External file, so the CSP needs no inline script.
// A built-in theme is just a data-theme value. A Visual Assault theme was saved together with the colours
// derived from it, so they can be applied straight away, before the stylesheet or the app have loaded.
try {
  var root = document.documentElement;
  var saved = localStorage.getItem('kvgrainy-theme');
  if (saved === 'dark' || saved === 'light' || saved === 'neon') {
    root.setAttribute('data-theme', saved);
  } else if (saved && saved.indexOf('va:') === 0) {
    var va = JSON.parse(localStorage.getItem('kvgrainy-va') || 'null');
    if (va && va.id === saved.slice(3) && va.vars) {
      root.setAttribute('data-theme', 'va');
      for (var name in va.vars) root.style.setProperty(name, va.vars[name]);
      if (va.scheme === 'light' || va.scheme === 'dark') root.style.colorScheme = va.scheme;
    }
  }
} catch (e) {
  /* storage blocked or unreadable: stay on the default theme */
}
