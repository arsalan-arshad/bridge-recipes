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

  // Writes: a POST with the same bearer token and a form-encoded body (the server rejects anything else).
  async function post(path, body, retry) {
    var token = await window.shopify.idToken();
    var res = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'omit' });
    if (res.status === 401 && retry) return post(path, body, false);
    return res;
  }

  async function show_response(res) {
    var type = res.headers.get('content-type') || '';
    if (type.indexOf('text/html') === 0) {
      root.innerHTML = await res.text(); // server-escaped HTML fragment (same rule as the admin pages); also for 400/422 with the problems
    } else if (res.status === 403) {
      show('This store is not set up for this Bridge Recipes service. Ask the operator to add it.');
    } else if (res.status === 413 || res.status === 415) {
      show('That request was refused. Reload the app and try again.');
    } else {
      show('Could not complete that. Reload the app.');
    }
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

  // Forms: <form data-post="/app/api/..."> with named fields (Polaris fields, or native inputs). Read every named field directly, so it
  // does not matter whether a Polaris field takes part in native form submission. Buttons marked data-submit send the form.
  function collect(form) {
    var params = new URLSearchParams();
    var fields = form.querySelectorAll('[name]');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var name = f.getAttribute('name');
      if (!name) continue;
      var tag = (f.tagName || '').toLowerCase();
      if (tag === 'input' && (f.type === 'checkbox' || f.type === 'radio')) {
        if (f.checked) params.append(name, f.value || 'on');
      } else if (tag === 's-checkbox') {
        if (f.checked) params.append(name, f.value || 'on');
      } else {
        params.append(name, f.value == null ? '' : String(f.value));
      }
    }
    return params;
  }

  async function send(form) {
    var path = form.getAttribute('data-post');
    if (!path || path.indexOf('/app/api/') !== 0) return;
    var buttons = form.querySelectorAll('[data-submit]');
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('disabled', '');
    try {
      await show_response(await post(path, collect(form).toString(), true));
    } catch (e) {
      show('Could not reach the service. Reload the app.');
    }
  }

  root.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-submit]') : null;
    var form = btn && btn.closest ? btn.closest('form[data-post]') : null;
    if (form && !btn.hasAttribute('disabled')) {
      ev.preventDefault();
      send(form);
    }
  });
  root.addEventListener('submit', function (ev) {
    var form = ev.target && ev.target.matches && ev.target.matches('form[data-post]') ? ev.target : null;
    if (form) {
      ev.preventDefault();
      send(form);
    }
  });

  if (window.shopify && typeof window.shopify.idToken === 'function') load('/app/api/home');
  else show('This page must be opened from the Shopify admin.');
})();
