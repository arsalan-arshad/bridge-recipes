// Tiny server-side HTML layer. THE RULE: every dynamic value goes through esc() (or is a number/boolean we format ourselves).
// No inline scripts, no event handlers, no external resources: the page works under a strict Content-Security-Policy.

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c] as string);
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // same-origin (not no-referrer): with no-referrer a browser posts forms with `Origin: null`, which the origin check must refuse.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--mut:#666;--line:#ddd;--card:#fff;--ok:#0a7d33;--warn:#a15c00;--bad:#b3261e;--acc:#1f5fbf}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#9a9a9a;--line:#333;--card:#202020;--ok:#4cc27a;--warn:#e0a040;--bad:#ff6b60;--acc:#7aa7ff}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--card)}
header a{color:var(--fg);text-decoration:none;font-weight:600}main{max-width:980px;margin:0 auto;padding:20px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 16px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.mut{color:var(--mut);font-size:13px}
label{display:block;font-weight:600;margin:10px 0 3px}input[type=text],input[type=password],textarea,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:70px;font-family:ui-monospace,monospace;font-size:13px}
button{padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.danger{background:var(--bad);border-color:var(--bad);color:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:700;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.notice{padding:10px 14px;border-radius:6px;margin:0 0 16px;border:1px solid currentColor}
code{font-family:ui-monospace,monospace;font-size:12px}
`;

export function layout(opts: { title: string; body: string; csrf?: string; nav?: boolean }): string {
  const nav = opts.nav === false ? '' : `<nav class="row"><a href="/admin">Shops</a><a href="/admin/replay">Failed jobs</a><a href="/admin/compliance">Compliance</a>
    <form method="post" action="/admin/logout">${opts.csrf ? `<input type="hidden" name="csrf" value="${esc(opts.csrf)}">` : ''}<button type="submit">Sign out</button></form></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(opts.title)} · Bridge Recipes</title><style>${CSS}</style></head>
<body><header><a href="/admin">Bridge Recipes · admin</a>${nav}</header><main>${opts.body}</main></body></html>`;
}

export function badge(text: string, tone: 'ok' | 'warn' | 'bad' | 'mut'): string {
  return `<span class="badge ${tone === 'mut' ? '' : tone}">${esc(text)}</span>`;
}

export function notice(text: string, tone: 'ok' | 'warn' | 'bad'): string {
  return `<div class="notice ${tone}" role="status">${esc(text)}</div>`;
}

export function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
}
