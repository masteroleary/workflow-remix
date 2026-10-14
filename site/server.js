'use strict';
// The WorkflowRemix website. Plain pages, wrapped in one layout as the server starts:
// no build step, no dependencies, no script sent to a browser, and nothing loaded from
// anywhere but this server — the typefaces and the icons included (assets/*.woff2, and
// icons.js written into the pages as inline SVG). The one request it makes itself is for the public release
// feeds (latest*.yml), so the Downloads page can link the installers without a visitor's
// browser ever talking to GitHub before they click one.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const ICONS = require('./icons.js');

const ROOT = __dirname;
const RELEASES = 'https://github.com/masteroleary/workflow-remix/releases';
// The desktop app's update feeds: the release workflow publishes a release only once all
// three, and the files they name, are attached.
const FEEDS = [
  { key: 'win', file: 'latest.yml' },
  { key: 'mac', file: 'latest-mac.yml' },
  { key: 'linux', file: 'latest-linux.yml' },
];
const PLATFORMS = [
  { feed: 'win', label: 'Windows', detail: '64-bit installer', pick: (n) => /\.exe$/i.test(n) },
  { feed: 'mac', label: 'macOS', detail: 'Apple silicon', pick: (n) => /arm64\.dmg$/i.test(n) },
  { feed: 'mac', label: 'macOS', detail: 'Intel', pick: (n) => /x64\.dmg$/i.test(n) },
  { feed: 'linux', label: 'Linux', detail: '64-bit AppImage', pick: (n) => /\.AppImage$/i.test(n) },
];
const RELEASE_REFRESH_MS = 10 * 60 * 1000;
const FEED_MAX = 64 * 1024;
const FEED_TIMEOUT_MS = 8000;

const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
// The site's places, drawn as the app draws its own: a sidebar on a computer, with the
// pages of the section you are in listed under it, and a tab bar along the bottom of a
// phone, whose middle button is the raised one (`main`), as Jobs is in the app.
const NAV = [
  { href: '/', label: 'Home', icon: 'home-outline' },
  { href: '/docs', label: 'Docs', icon: 'book-open-page-variant-outline', section: 'docs' },
  { href: '/downloads', label: 'Downloads', tab: 'Get it', icon: 'tray-arrow-down', main: true },
  { href: '/examples', label: 'Examples', icon: 'lightbulb-on-outline', section: 'examples' },
  { href: '/acceptable-use', label: 'Acceptable Use', tab: 'Policy', icon: 'scale-balance' },
];
const SECTIONS = { docs: 'Documentation', examples: 'Examples' };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (tpl, vars) => tpl.replace(/\{\{([a-z-]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

// An icon of icons.js as inline SVG, in the text colour, hidden from a screen reader: the
// words beside it say what it is. A name icons.js does not have is a mistake in a page,
// and stops the server rather than leaving a gap.
function icon(name) {
  if (!Object.prototype.hasOwnProperty.call(ICONS, name)) throw new Error(`no icon named "${name}" in icons.js`);
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`;
}
const icons = (html) => html.replace(/\{\{icon:([a-z0-9-]+)\}\}/g, (m, name) => icon(name));

// ── Pages ────────────────────────────────────────────────────────────────────

// A page is an HTML fragment whose first comment holds its `key: value` lines.
function parsePage(rel, text) {
  const m = /^\s*<!--([\s\S]*?)-->\s*/.exec(text);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const name = rel.replace(/\.html$/, '');
  const route = name === 'index' ? '/' : '/' + name.replace(/\/index$/, '');
  return { rel, route, meta, body: m ? text.slice(m[0].length) : text };
}

function readPages(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(d, ent.name), rel + ent.name + '/');
      else if (ent.name.endsWith('.html')) {
        out.push(parsePage(rel + ent.name, fs.readFileSync(path.join(d, ent.name), 'utf8')));
      }
    }
  })(dir, '');
  return out;
}

// ── The policy and the licence ───────────────────────────────────────────────
// legal/ holds copies of the app's own ACCEPTABLE_USE.md and LICENSE, word for word.
// They are rendered from the files rather than retyped into a page, so replacing a
// file is the whole of an update.

function inline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      if (/^https:\/\//.test(href)) return `<a href="${href}" rel="noopener noreferrer">${label}</a>`;
      if (href === 'LICENSE') return `<a href="/licence">${label}</a>`;
      return label;
    });
}

// The Markdown the policy is written in, and no more of it: headings, paragraphs, and
// bulleted or numbered lists one level deep inside each other, with wrapped lines.
function renderPolicy(md) {
  const html = [];
  const open = [];           // open lists: { tag, indent }
  let para = [];
  let item = null;           // lines of the list item being read
  const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushItem = () => { if (item) { html.push(inline(item.join(' '))); item = null; } };
  const closeTo = (depth) => {
    flushItem();
    while (open.length > depth) { html.push(`</li></${open.pop().tag}>`); }
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!line) { flushPara(); flushItem(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h && indent === 0) {
      flushPara(); closeTo(0);
      html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = /^(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const tag = li[1] ? 'ul' : 'ol';
      while (open.length && open[open.length - 1].indent > indent) closeTo(open.length - 1);
      const top = open[open.length - 1];
      if (top && top.indent === indent) { flushItem(); html.push('</li><li>'); }
      else { flushItem(); open.push({ tag, indent }); html.push(`<${tag}><li>`); }
      item = [li[3]];
      continue;
    }
    if (indent > 0 && open.length) { (item || (item = [])).push(line); continue; }
    closeTo(0);
    para.push(line);
  }
  flushPara(); closeTo(0);
  return html.join('\n');
}

// The licence is plain text: paragraphs, with a line in capitals as a heading.
function renderLicence(text) {
  return text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map((block) => {
    const one = block.replace(/\n/g, ' ').trim();
    if (/^[A-Z][A-Z ]{2,40}$/.test(one)) return `<h2>${esc(one)}</h2>`;
    return `<p>${esc(one)}</p>`;
  }).join('\n');
}

// ── Releases ─────────────────────────────────────────────────────────────────

// electron-builder's feed: `version:`, a list of `- url:` with a `size:` each, and
// `releaseDate:`. Read line by line, and only what has the shape it should: a name that
// is a file name and nothing else is all that ever reaches a link.
function parseFeed(text) {
  if (typeof text !== 'string') return null;
  let version = null;
  let date = null;
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^version:\s*['"]?([0-9][0-9A-Za-z.+-]{0,39})['"]?\s*$/.exec(line))) version = m[1];
    else if ((m = /^releaseDate:\s*['"]?([0-9][0-9T:.Z+-]{9,39})['"]?\s*$/.exec(line))) date = m[1];
    else if ((m = /^\s*-\s*url:\s*['"]?([A-Za-z0-9][A-Za-z0-9._-]{0,119})['"]?\s*$/.exec(line))) {
      files.push({ name: m[1], size: 0 });
    } else if ((m = /^\s+size:\s*(\d{1,15})\s*$/.exec(line)) && files.length) {
      files[files.length - 1].size = Number(m[1]);
    }
  }
  if (!version || !files.length) return null;
  return { version, date: date && !Number.isNaN(Date.parse(date)) ? date : null, files };
}

// '' for a feed that is not there (no release yet), null for a read that failed.
function fetchText(url, left = 5) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    if (u.protocol !== 'https:' || !/^(github\.com|[a-z0-9-]+\.githubusercontent\.com)$/.test(u.hostname)) {
      return resolve(null);
    }
    const req = https.get(u, {
      headers: { 'User-Agent': 'workflowremix-site', Accept: '*/*' },
      timeout: FEED_TIMEOUT_MS,
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && left > 0) {
        r.resume();
        return resolve(fetchText(new URL(r.headers.location, u).href, left - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(r.statusCode === 404 ? '' : null); }
      const chunks = [];
      let n = 0;
      r.on('data', (c) => {
        n += c.length;
        if (n > FEED_MAX) { req.destroy(); resolve(null); } else chunks.push(c);
      });
      r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      r.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const fmtSize = (n) => (n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n > 0 ? `${Math.max(1, Math.round(n / 1e3))} kB` : '');
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});

// `feeds` is { win, mac, linux }, each a parsed feed or absent.
function renderDownloads(feeds) {
  const any = FEEDS.map((f) => feeds[f.key]).filter(Boolean);
  if (!any.length) {
    return [
      '<div class="callout soon">',
      '<p class="callout-title">The first public release is not out yet.</p>',
      '<p>When it is, the installers for Windows, macOS and Linux appear on this page by',
      'themselves. Nothing to sign up for in the meantime.</p>',
      '</div>',
      '<ul class="dl-list">',
      ...PLATFORMS.map((p) => `<li class="dl"><div><p class="dl-os">${esc(p.label)}</p>`
        + `<p class="dl-file">${esc(p.detail)}</p></div><span class="btn off">Coming soon</span></li>`),
      '</ul>',
    ].join('\n');
  }
  const newest = any.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  const rows = PLATFORMS.map((p) => {
    const feed = feeds[p.feed];
    const file = feed && feed.files.find((f) => p.pick(f.name));
    const head = `<div><p class="dl-os">${esc(p.label)} <span class="dl-arch">${esc(p.detail)}</span></p>`;
    if (!file) return `<li class="dl">${head}<p class="dl-file">Not in this release</p></div></li>`;
    const size = fmtSize(file.size);
    return `<li class="dl">${head}<p class="dl-file">${esc(file.name)}${size ? ` · ${size}` : ''}</p></div>`
      + `<a class="btn primary" href="${RELEASES}/latest/download/${encodeURIComponent(file.name)}" `
      + `rel="noopener noreferrer">${icon('tray-arrow-down')}Download</a></li>`;
  });
  return [
    `<p class="dl-version">Version <strong>${esc(newest.version)}</strong>`
      + (newest.date ? ` · released ${esc(fmtDate(newest.date))}` : '') + '</p>',
    '<ul class="dl-list">', ...rows, '</ul>',
  ].join('\n');
}

function renderReleaseLine(feeds) {
  const any = FEEDS.map((f) => feeds[f.key]).filter(Boolean);
  if (!any.length) return 'Windows, macOS and Linux. The first public release is on its way.';
  return `Version ${esc(any[0].version)} for Windows, macOS and Linux.`;
}

// The sidebar card's line: the version on offer, or that there is none yet.
function renderReleaseShort(feeds) {
  const any = FEEDS.map((f) => feeds[f.key]).filter(Boolean);
  return any.length ? `Version ${esc(any[0].version)}` : 'First release soon';
}

// ── The site ─────────────────────────────────────────────────────────────────

function createSite(opts = {}) {
  const origin = String(opts.origin || process.env.SITE_ORIGIN || 'https://workflowremix.com').replace(/\/+$/, '');
  const canonHost = new URL(origin).host;
  const fetchFeed = opts.fetchFeed || ((file) => fetchText(`${RELEASES}/latest/download/${file}`));
  const log = opts.log || ((...a) => console.log(...a));

  const layout = icons(fs.readFileSync(path.join(ROOT, 'layout.html'), 'utf8'));
  const pages = readPages(path.join(ROOT, 'pages'));
  const policy = renderPolicy(fs.readFileSync(path.join(ROOT, 'legal', 'ACCEPTABLE_USE.md'), 'utf8'));
  const licence = renderLicence(fs.readFileSync(path.join(ROOT, 'legal', 'LICENSE'), 'utf8'));
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'site.css'));
  const cssV = crypto.createHash('sha256').update(css).digest('hex').slice(0, 12);
  const feeds = {};
  const routes = new Map();

  function entry(body, type, extra) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const e = {
      buf, type,
      etag: 'W/"' + crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 22) + '"',
      ...extra,
    };
    if (/^(text\/|image\/svg|application\/xml)/.test(type) && buf.length > 512) {
      e.br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
      e.gz = zlib.gzipSync(buf, { level: 9 });
    }
    return e;
  }

  const inSection = (name) => pages
    .filter((p) => p.meta.section === name)
    .sort((a, b) => Number(a.meta.order || 0) - Number(b.meta.order || 0));

  function sideNav(page) {
    const list = inSection(page.meta.section);
    const items = list.map((p) => `<li><a href="${p.route}"${p === page ? ' aria-current="page"' : ''}>`
      + `${esc(p.meta.nav || p.meta.title)}</a></li>`).join('\n');
    const i = list.indexOf(page);
    const prev = list[i - 1];
    const next = list[i + 1];
    const pager = '<nav class="pager" aria-label="Previous and next page">'
      + (prev ? `<a class="prev" href="${prev.route}"><span>Previous</span>${esc(prev.meta.nav || prev.meta.title)}</a>` : '<span></span>')
      + (next ? `<a class="next" href="${next.route}"><span>Next</span>${esc(next.meta.nav || next.meta.title)}</a>` : '<span></span>')
      + '</nav>';
    return { items, pager, label: SECTIONS[page.meta.section] || page.meta.section };
  }

  function renderPage(page) {
    const body = fill(icons(page.body), {
      downloads: renderDownloads(feeds),
      'release-line': renderReleaseLine(feeds),
      policy,
      licence,
    });
    let main;
    const side = page.meta.section ? sideNav(page) : null;
    if (side) {
      // The sidebar lists the section's pages on a computer; a phone has no sidebar,
      // so the page carries them itself, folded away above the text.
      main = `<div class="shell">
<details class="side-menu"><summary>${esc(side.label)} menu</summary><ul>${side.items}</ul></details>
<main id="main" class="prose">
${body}
${side.pager}
</main>
</div>`;
    } else if (page.meta.layout === 'wide') {
      main = `<main id="main">\n${body}\n</main>`;
    } else {
      main = `<div class="shell"><main id="main" class="prose">\n${body}\n</main></div>`;
    }
    // Which place the page belongs to: its first path segment, so /docs/remix is Docs.
    const top = '/' + page.route.split('/')[1];
    const current = (n) => (n.href === top ? ' aria-current="page"' : '');
    const sidebar = NAV.map((n) => `<a class="sb-item${n.href === top ? ' on' : ''}" href="${n.href}"${current(n)}>`
      + `${icon(n.icon)}<span>${esc(n.label)}</span></a>`
      + (side && n.section === page.meta.section ? `\n<ul class="sb-sub">${side.items}</ul>` : '')).join('\n');
    const tabs = NAV.map((n) => (n.main
      ? `<a class="tab-main${n.href === top ? ' on' : ''}" href="${n.href}"${current(n)}><span class="tab-main-ic">${icon(n.icon)}</span><span>${esc(n.tab || n.label)}</span></a>`
      : `<a class="tab-item${n.href === top ? ' on' : ''}" href="${n.href}"${current(n)}>${icon(n.icon)}<span>${esc(n.tab || n.label)}</span></a>`)).join('\n');
    const title = page.route === '/' ? page.meta.title : `${page.meta.title} · WorkflowRemix`;
    return fill(layout, {
      title: esc(title),
      description: esc(page.meta.description || ''),
      canonical: esc(origin + (page.route === '/' ? '/' : page.route)),
      css: cssV,
      sidebar,
      tabs,
      'release-short': renderReleaseShort(feeds),
      main,
      robots: page.meta.hidden ? '<meta name="robots" content="noindex">' : '',
    });
  }

  function build() {
    for (const page of pages) {
      routes.set(page.route, entry(renderPage(page), 'text/html; charset=utf-8', { hidden: !!page.meta.hidden }));
    }
  }

  routes.set('/assets/site.css', entry(css, TYPES['.css'], { v: cssV }));
  for (const name of fs.readdirSync(path.join(ROOT, 'assets'))) {
    const type = TYPES[path.extname(name)];
    if (!type || name === 'site.css') continue;
    const e = entry(fs.readFileSync(path.join(ROOT, 'assets', name)), type, { cache: 'public, max-age=86400' });
    routes.set('/assets/' + name, e);
    if (/^(favicon\.(ico|svg)|apple-touch-icon\.png)$/.test(name)) routes.set('/' + name, e);
  }
  const listed = pages.filter((p) => !p.meta.hidden).map((p) => p.route).sort();
  routes.set('/robots.txt', entry(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, TYPES['.txt']));
  routes.set('/sitemap.xml', entry('<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + listed.map((r) => `  <url><loc>${esc(origin + r)}</loc></url>`).join('\n')
    + '\n</urlset>\n', 'application/xml; charset=utf-8'));
  build();
  if (!routes.has('/404')) throw new Error('pages/404.html is missing');

  function plain(res, status, text) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text + '\n');
  }

  function send(req, res, e, status, url) {
    res.statusCode = status;
    res.setHeader('Content-Type', e.type);
    const pinned = e.v && url && url.searchParams.get('v') === e.v;
    res.setHeader('Cache-Control', pinned ? 'public, max-age=31536000, immutable' : (e.cache || 'no-cache'));
    let body = e.buf;
    if (e.br) {
      res.setHeader('Vary', 'Accept-Encoding');
      const ae = String(req.headers['accept-encoding'] || '');
      if (/\bbr\b/.test(ae)) { body = e.br; res.setHeader('Content-Encoding', 'br'); }
      else if (/\bgzip\b/.test(ae)) { body = e.gz; res.setHeader('Content-Encoding', 'gzip'); }
    }
    if (status === 200) {
      res.setHeader('ETag', e.etag);
      if (req.headers['if-none-match'] === e.etag) { res.statusCode = 304; return res.end(); }
    }
    res.setHeader('Content-Length', body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function handle(req, res) {
    const host = String(req.headers.host || '').toLowerCase();
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (proto === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // Only the real address is for search engines: not the host's own name for the service.
    if (host !== canonHost) res.setHeader('X-Robots-Tag', 'noindex');

    let url;
    let p;
    try {
      // Joined, not resolved: resolved against a base, "//docs" is a host name.
      if (req.url[0] !== '/') throw new Error('not a path');
      url = new URL('http://site.invalid' + req.url);
      p = decodeURIComponent(url.pathname);
    } catch { return plain(res, 400, 'Bad request'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return plain(res, 405, 'Method not allowed');
    }
    if (p === '/healthz') return plain(res, 200, 'ok');
    if (host === 'www.' + canonHost || (host === canonHost && proto === 'http')) {
      res.statusCode = 308;
      res.setHeader('Location', origin + url.pathname + url.search);
      return res.end();
    }
    let clean = p.replace(/\/{2,}/g, '/');
    if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
    clean = clean.replace(/\.html$/, '').replace(/\/index$/, '') || '/';
    if (clean !== p && routes.has(clean) && !routes.get(clean).hidden) {
      res.statusCode = 308;
      res.setHeader('Location', clean + url.search);
      return res.end();
    }
    const e = routes.get(p);
    if (!e || e.hidden) return send(req, res, routes.get('/404'), 404, url);
    return send(req, res, e, 200, url);
  }

  function handler(req, res) {
    try { handle(req, res); } catch (err) {
      log('[site] request failed:', err && err.stack || err);
      if (!res.headersSent) plain(res, 500, 'Internal error'); else res.destroy();
    }
  }

  // A feed that is gone ('') is forgotten; a read that failed (null) changes nothing.
  async function refreshReleases() {
    let changed = false;
    for (const f of FEEDS) {
      let text = null;
      try { text = await fetchFeed(f.file); } catch { text = null; }
      if (text === null) continue;
      const next = text === '' ? undefined : parseFeed(text) || undefined;
      if (JSON.stringify(next) !== JSON.stringify(feeds[f.key])) {
        changed = true;
        if (next) feeds[f.key] = next; else delete feeds[f.key];
      }
    }
    if (changed) {
      build();
      log('[site] releases:', FEEDS.map((f) => `${f.key}=${feeds[f.key] ? feeds[f.key].version : 'none'}`).join(' '));
    }
    return changed;
  }

  function watchReleases() {
    refreshReleases();
    const t = setInterval(refreshReleases, RELEASE_REFRESH_MS);
    t.unref();
    return t;
  }

  return { handler, refreshReleases, watchReleases, origin, routes, pages };
}

if (require.main === module) {
  const site = createSite();
  const port = Number(process.env.PORT) || 8791;
  const host = process.env.HOST || undefined;
  const server = http.createServer(site.handler);
  server.listen(port, host, () => {
    console.log(`[site] ${site.pages.length} pages for ${site.origin}, listening on ${host || 'every address'}:${port}`);
  });
  site.watchReleases();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
  }
}

module.exports = { createSite, parseFeed, renderPolicy, renderLicence, renderDownloads, icon };
