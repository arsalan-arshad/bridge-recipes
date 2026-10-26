// Browser side of the embedded app. Plain JavaScript on purpose: browsers do not strip TypeScript and the project has no
// build step. It only fetches server-rendered HTML with a fresh Shopify ID token and shows it; all decisions are server side.
// Served as /app/assets/app.js and loaded under a Content-Security-Policy that forbids inline script.
(function () {
  var root = document.getElementById('app');
  if (!root) return;

  function show(message) {
    root.textContent = message;
  }

  // An ID token lives about a minute, so ask for a fresh one on every request; on a 401 try once more (the server asks for that
  // with X-Shopify-Retry-Invalid-Session-Request).
  async function get(path, retry) {
    var token = await window.shopify.idToken();
    var res = await fetch(path, { headers: { Authorization: 'Bearer ' + token }, credentials: 'omit' });
    if (res.status === 401 && retry) return get(path, false);
    return res;
  }

  async function load(path) {
    try {
      var res = await get(path, true);
      if (res.ok) {
        root.innerHTML = await res.text(); // server-escaped HTML fragment (same rule as the admin pages)
      } else if (res.status === 403) {
        show('This store is not set up for this Bridge Recipes service. Ask the operator to add it.');
      } else {
        show('Could not load this page. Reload the app.');
      }
    } catch (e) {
      show('Could not reach the service. Reload the app.');
    }
  }

  // Navigation: elements carry data-view="/app/api/..." (set by the server, never by user input). No inline handlers (CSP).
  root.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-view]') : null;
    var path = el ? el.getAttribute('data-view') : null;
    if (path && path.indexOf('/app/api/') === 0) {
      ev.preventDefault();
      load(path);
    }
  });

  if (window.shopify && typeof window.shopify.idToken === 'function') load('/app/api/home');
  else show('This page must be opened from the Shopify admin.');
})();
