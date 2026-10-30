// Classic script (not a module) so the theme is applied before the first paint.
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var scheme = tg && tg.initData ? tg.colorScheme : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', scheme === 'dark' ? 'dark' : 'light');
})();
