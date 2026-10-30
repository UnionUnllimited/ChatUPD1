// Classic script (not a module) so the theme is applied before the first paint.
// A theme picked in the profile wins; otherwise follow Telegram (or the system outside it).
(function () {
  var pref = 'auto';
  try { pref = localStorage.getItem('linza_theme') || 'auto'; } catch (e) {}
  var tg = window.Telegram && window.Telegram.WebApp;
  var scheme = tg && tg.initData ? tg.colorScheme : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (pref === 'light' || pref === 'dark') scheme = pref;
  document.documentElement.setAttribute('data-theme', scheme === 'dark' ? 'dark' : 'light');
})();
