'use strict';
// The site is met the way a browser meets it: a server on a loopback port of its own,
// with the release feeds answered by the test, so nothing here reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { createSite, parseFeed, renderPolicy } = require('../server.js');

const ORIGIN = 'https://workflowremix.com';
const WIN = "version: 1.2.3\nfiles:\n  - url: WorkflowRemix-Setup-1.2.3.exe\n    sha512: abc==\n    size: 112026411\npath: WorkflowRemix-Setup-1.2.3.exe\nsha512: abc==\nreleaseDate: '2026-11-02T10:00:00.000Z'\n";
const MAC = "version: 1.2.3\nfiles:\n  - url: WorkflowRemix-1.2.3-arm64.dmg\n    sha512: a\n    size: 120000000\n  - url: WorkflowRemix-1.2.3-x64.dmg\n    sha512: a\n    size: 125000000\n  - url: WorkflowRemix-1.2.3-arm64-mac.zip\n    sha512: a\n    size: 118000000\nreleaseDate: '2026-11-02T10:05:00.000Z'\n";
const LINUX = "version: 1.2.3\nfiles:\n  - url: WorkflowRemix-1.2.3.AppImage\n    sha512: a\n    size: 130000000\nreleaseDate: '2026-11-02T10:02:00.000Z'\n";

async function start(feeds = {}) {
  const state = { feeds };
  const site = createSite({ origin: ORIGIN, log: () => {}, fetchFeed: async (file) => (file in state.feeds ? state.feeds[file] : '') });
  const server = http.createServer(site.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p, opts = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  return { site, state, get, close: () => new Promise((r) => server.close(r)) };
}

const visible = (site) => site.pages.filter((p) => !p.meta.hidden);

test('every page answers, in the layout, with a title and one heading', async () => {
  const s = await start();
  try {
    assert.ok(visible(s.site).length >= 18, 'the pages are all there');
    for (const page of visible(s.site)) {
      const r = await s.get(page.route);
      const html = r.body.toString('utf8');
      assert.equal(r.status, 200, page.route);
      assert.match(r.headers['content-type'], /^text\/html/);
      assert.match(html, /^<!doctype html>/, page.route);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${page.route} has one h1`);
      assert.match(html, /<title>[^<]{5,}<\/title>/, page.route);
      assert.match(html, /<meta name="description" content="[^"]{20,}">/, `${page.route} has a description`);
      assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${page.route === '/' ? '/' : page.route}">`), page.route);
      assert.ok(!/\{\{[a-z0-9:-]+\}\}/.test(html), `${page.route} has no unfilled marker`);
      assert.ok(html.includes('id="main"'), page.route);
    }
  } finally { await s.close(); }
});

test('every link inside the site leads somewhere, anchors included', async () => {
  const s = await start({ 'latest.yml': WIN, 'latest-mac.yml': MAC, 'latest-linux.yml': LINUX });
  try {
    await s.site.refreshReleases();
    const bodies = new Map();
    for (const page of s.site.pages) bodies.set(page.route, s.site.routes.get(page.route).buf.toString('utf8'));
    for (const [route, html] of bodies) {
      for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const ref = m[1];
        if (/^https:\/\//.test(ref)) continue;
        assert.ok(ref.startsWith('/') || ref.startsWith('#'), `${route}: ${ref} is neither absolute nor an anchor`);
        const [p, frag] = ref.split('#');
        const target = p ? p.split('?')[0] : route;
        const e = s.site.routes.get(target);
        assert.ok(e && (!p || !e.hidden), `${route} links to ${ref}, which is not a page`);
        if (frag) assert.ok(bodies.get(target).includes(`id="${frag}"`), `${route} links to ${ref}, and ${target} has no such anchor`);
      }
    }
  } finally { await s.close(); }
});

test('no page needs anything the policy refuses, or loads from anywhere else', async () => {
  const s = await start({ 'latest.yml': WIN });
  try {
    await s.site.refreshReleases();
    const allowed = /^https:\/\/(github\.com\/masteroleary\/workflow-remix\/releases|tailscale\.com|ollama\.com|huggingface\.co\/llmfan46\/Qwen3\.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF|report\.cybertip\.org|report\.iwf\.org\.uk|www\.inhope\.org)/;
    for (const page of s.site.pages) {
      const html = s.site.routes.get(page.route).buf.toString('utf8');
      assert.ok(!/<script/i.test(html), `${page.route} has a script`);
      assert.ok(!/\sstyle=/i.test(html), `${page.route} has an inline style`);
      assert.ok(!/<style/i.test(html), `${page.route} has a style element`);
      assert.ok(!/\son[a-z]+=/i.test(html), `${page.route} has an inline handler`);
      assert.ok(!/(?:src|srcset)="https?:/i.test(html), `${page.route} loads something from another site`);
      assert.ok(!/http:\/\/(?!127\.0\.0\.1:8188)/.test(html.replace(/http:\/\/www\.sitemaps\.org[^"]*/g, '')), `${page.route} names a plain-http address`);
      for (const m of html.matchAll(/href="(https:\/\/[^"]+)"/g)) {
        if (m[1].startsWith(ORIGIN)) continue;
        assert.match(m[1], allowed, `${page.route} links to ${m[1]}`);
      }
    }
    // The stylesheet loads its two typefaces from this site, and nothing else.
    const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'site.css'), 'utf8');
    assert.ok(!/@import/i.test(css), 'the stylesheet imports nothing');
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]);
    assert.deepEqual(urls.sort(), ['/assets/instrument-sans-latin.woff2', '/assets/jetbrains-mono-latin.woff2'], 'only the fonts');
    for (const u of urls) {
      const r = await s.get(u);
      assert.equal(r.status, 200, u);
      assert.equal(r.headers['content-type'], 'font/woff2', u);
      assert.equal(r.body.subarray(0, 4).toString('latin1'), 'wOF2', `${u} is a woff2 file`);
    }
  } finally { await s.close(); }
});

test('the icons are inline SVG from icons.js, and a name it lacks stops the server', async () => {
  const { icon } = require('../server.js');
  const svg = icon('tray-arrow-down');
  assert.match(svg, /^<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M[0-9A-Za-z .,-]+"\/><\/svg>$/);
  for (const bad of ['no-such-icon', 'constructor', '__proto__', 'toString']) assert.throws(() => icon(bad), /no icon named/, bad);
  const s = await start({ 'latest.yml': WIN });
  try {
    await s.site.refreshReleases();
    const home = (await s.get('/')).body.toString('utf8');
    assert.ok((home.match(/<svg class="ic"/g) || []).length >= 9, 'the home page draws its icons');
    assert.match((await s.get('/downloads')).body.toString('utf8'), /<a class="btn primary" href="[^"]+" rel="noopener noreferrer"><svg class="ic"[^>]*><path d="[^"]+"\/><\/svg>Download<\/a>/);
  } finally { await s.close(); }
});

test('what the site draws with is credited, and its licences are served beside it', async () => {
  const s = await start();
  try {
    const r = await s.get('/assets/third-party.txt');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/plain/);
    const text = r.body.toString('utf8');
    for (const phrase of ['Instrument Sans', 'JetBrains Mono', 'SIL OPEN FONT LICENSE Version 1.1', 'Material Design Icons',
      'Apache License', 'END OF TERMS AND CONDITIONS']) assert.ok(text.includes(phrase), phrase);
    const icons = fs.readFileSync(path.join(__dirname, '..', 'icons.js'), 'utf8');
    assert.match(icons, /Apache License, Version 2\.0/, 'icons.js names its licence');
    for (const page of visible(s.site)) {
      assert.ok(s.site.routes.get(page.route).buf.toString('utf8').includes('<a href="/assets/third-party.txt">'), `${page.route} links the notices`);
    }
  } finally { await s.close(); }
});

test('every answer carries the page policy and its companions', async () => {
  const s = await start();
  try {
    for (const p of ['/', '/docs', '/assets/site.css', '/favicon.svg', '/nope', '/healthz', '/robots.txt']) {
      const r = await s.get(p, { headers: { host: 'workflowremix.com', 'x-forwarded-proto': 'https' } });
      const csp = r.headers['content-security-policy'];
      assert.match(csp, /default-src 'none'/, p);
      assert.match(csp, /frame-ancestors 'none'/, p);
      assert.ok(!/unsafe|script-src|\*/.test(csp), p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
      assert.equal(r.headers['x-frame-options'], 'DENY', p);
      assert.equal(r.headers['strict-transport-security'], 'max-age=31536000', p);
      assert.equal(r.headers['x-robots-tag'], undefined, p);
      assert.equal(r.headers['set-cookie'], undefined, p);
    }
    const plainHttp = await s.get('/docs');
    assert.equal(plainHttp.headers['strict-transport-security'], undefined, 'no HSTS without TLS in front');
    assert.equal(plainHttp.headers['x-robots-tag'], 'noindex', 'only the real address is indexed');
    const other = await s.get('/', { headers: { host: 'something.up.railway.app', 'x-forwarded-proto': 'https' } });
    assert.equal(other.status, 200);
    assert.equal(other.headers['x-robots-tag'], 'noindex');
  } finally { await s.close(); }
});

test('addresses are tidied by redirect', async () => {
  const s = await start();
  try {
    const cases = [['/docs/', '/docs'], ['/docs/index.html', '/docs'], ['/downloads.html', '/downloads'],
      ['/docs/remix/', '/docs/remix'], ['/index.html', '/'], ['//docs//remix', '/docs/remix']];
    for (const [from, to] of cases) {
      const r = await s.get(from);
      assert.equal(r.status, 308, from);
      assert.equal(r.headers.location, to, from);
    }
    const www = await s.get('/docs/remix?x=1', { headers: { host: 'www.workflowremix.com', 'x-forwarded-proto': 'https' } });
    assert.equal(www.status, 308);
    assert.equal(www.headers.location, `${ORIGIN}/docs/remix?x=1`);
    const insecure = await s.get('/downloads', { headers: { host: 'workflowremix.com', 'x-forwarded-proto': 'http' } });
    assert.equal(insecure.status, 308);
    assert.equal(insecure.headers.location, `${ORIGIN}/downloads`);
    const evil = await s.get('/docs', { headers: { host: 'www.evil.example', 'x-forwarded-proto': 'https' } });
    assert.equal(evil.status, 200, 'another name is served, never redirected to');
  } finally { await s.close(); }
});

test('what is not a page is a 404, and nothing outside the pages is served', async () => {
  const s = await start();
  try {
    for (const p of ['/nope', '/404', '/server.js', '/icons.js', '/layout.html', '/package.json', '/railway.json', '/legal/LICENSE',
      '/legal/ACCEPTABLE_USE.md', '/pages/index.html', '/test/site.test.js', '/assets/../server.js', '/assets/..%2fserver.js',
      '/..%2f..%2fserver.js', '/assets/', '/docs/nope', '/%00', '/.git/config', '/.env']) {
      const r = await s.get(p);
      assert.equal(r.status, 404, p);
      assert.match(r.body.toString('utf8'), /Page not found/, p);
      assert.equal(r.headers.etag, undefined, p);
    }
    assert.equal((await s.get('/%E0%A4%A')).status, 400, 'an address that does not decode');
    assert.equal((await s.get('http://evil.example/docs')).status, 400, 'a request that names another site');
    const post = await s.get('/', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    const head = await s.get('/docs', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.ok(Number(head.headers['content-length']) > 1000);
    assert.equal((await s.get('/healthz')).body.toString(), 'ok\n');
  } finally { await s.close(); }
});

test('text is compressed when asked for, and revalidated by its tag', async () => {
  const s = await start();
  try {
    const plain = await s.get('/docs/prompts');
    const br = await s.get('/docs/prompts', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    const gz = await s.get('/docs/prompts', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.ok(br.body.length < plain.body.length / 2);
    assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);
    assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);
    assert.equal(plain.headers['cache-control'], 'no-cache');
    const again = await s.get('/docs/prompts', { headers: { 'if-none-match': plain.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);

    const html = plain.body.toString('utf8');
    const href = /href="(\/assets\/site\.css\?v=[0-9a-f]{12})"/.exec(html)[1];
    assert.match((await s.get(href)).headers['cache-control'], /immutable/);
    assert.equal((await s.get('/assets/site.css')).headers['cache-control'], 'no-cache');
    assert.equal((await s.get('/assets/site.css?v=000000000000')).headers['cache-control'], 'no-cache');
    for (const icon of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']) {
      const r = await s.get(icon);
      assert.equal(r.status, 200, icon);
      assert.match(r.headers['content-type'], /^image\//, icon);
    }
  } finally { await s.close(); }
});

test('with no release, Downloads says so and links no installer', async () => {
  const s = await start();
  try {
    assert.equal(await s.site.refreshReleases(), false, 'nothing to change');
    const html = (await s.get('/downloads')).body.toString('utf8');
    assert.match(html, /The first public release is not out yet/);
    assert.equal((html.match(/Coming soon/g) || []).length, 4);
    assert.ok(!html.includes('/releases/latest/download/'));
    assert.match((await s.get('/')).body.toString('utf8'), /The first public release is on its way/);
  } finally { await s.close(); }
});

test('a release appears by itself, one installer per system', async () => {
  const s = await start();
  try {
    const before = (await s.get('/downloads')).headers.etag;
    s.state.feeds = { 'latest.yml': WIN, 'latest-mac.yml': MAC, 'latest-linux.yml': LINUX };
    assert.equal(await s.site.refreshReleases(), true);
    const r = await s.get('/downloads');
    const html = r.body.toString('utf8');
    assert.notEqual(r.headers.etag, before);
    assert.match(html, /Version <strong>1\.2\.3<\/strong> · released 2 November 2026/);
    const links = [...html.matchAll(/href="(https:\/\/github\.com\/masteroleary\/workflow-remix\/releases\/latest\/download\/[^"]+)"/g)].map((m) => m[1].split('/').pop());
    assert.deepEqual(links, ['WorkflowRemix-Setup-1.2.3.exe', 'WorkflowRemix-1.2.3-arm64.dmg', 'WorkflowRemix-1.2.3-x64.dmg', 'WorkflowRemix-1.2.3.AppImage']);
    assert.ok(!html.includes('mac.zip'), 'the update archives are not offered');
    assert.match(html, /112 MB/);
    assert.ok(!/Coming soon|not out yet/.test(html));
    assert.match((await s.get('/')).body.toString('utf8'), /Version 1\.2\.3 for Windows, macOS and Linux/);

    // A read that fails changes nothing; a feed that is gone takes its installers with it.
    s.site.routes.get('/downloads');
    const failing = createSite({ origin: ORIGIN, log: () => {}, fetchFeed: async () => null });
    assert.equal(await failing.refreshReleases(), false);
    s.state.feeds = { 'latest.yml': WIN };
    assert.equal(await s.site.refreshReleases(), true);
    const partial = (await s.get('/downloads')).body.toString('utf8');
    assert.equal((partial.match(/Not in this release/g) || []).length, 3);
    assert.equal((partial.match(/\/releases\/latest\/download\//g) || []).length, 1);
  } finally { await s.close(); }
});

test('a feed is read for file names and nothing else', async () => {
  assert.deepEqual(parseFeed(WIN), {
    version: '1.2.3', date: '2026-11-02T10:00:00.000Z',
    files: [{ name: 'WorkflowRemix-Setup-1.2.3.exe', size: 112026411 }],
  });
  assert.equal(parseFeed(''), null);
  assert.equal(parseFeed('<html>Not Found</html>'), null);
  assert.equal(parseFeed(null), null);
  const hostile = [
    'version: 9.9.9',
    'files:',
    '  - url: ../../evil.exe',
    '  - url: https://evil.example/x.exe',
    '  - url: "><script>alert(1)</script>.exe',
    '  - url: a b.exe',
    '  - url: Fine-9.9.9.exe',
    '    size: 12',
    "releaseDate: 'not a date at all'",
  ].join('\n');
  assert.deepEqual(parseFeed(hostile), { version: '9.9.9', date: null, files: [{ name: 'Fine-9.9.9.exe', size: 12 }] });
  assert.equal(parseFeed('version: <b>1</b>\nfiles:\n  - url: a.exe\n'), null);

  const s = await start({ 'latest.yml': hostile });
  try {
    await s.site.refreshReleases();
    const html = (await s.get('/downloads')).body.toString('utf8');
    assert.ok(!/evil|<script|alert/.test(html));
    assert.match(html, /releases\/latest\/download\/Fine-9\.9\.9\.exe"/);
  } finally { await s.close(); }
});

test('the policy and the licence are the files, word for word', async () => {
  const s = await start();
  try {
    const words = (t) => t.replace(/<\/?(?:a|strong)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const md = fs.readFileSync(path.join(__dirname, '..', 'legal', 'ACCEPTABLE_USE.md'), 'utf8');
    const expected = words(md.replace(/^#{1,3}\s+/gm, '').replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
      .replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
    const page = (await s.get('/acceptable-use')).body.toString('utf8');
    const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(page)[1];
    assert.equal(words(main), expected);
    assert.match(md, /^Last updated: \d{4}-\d{2}-\d{2}$/m, 'the policy states its date');

    const html = renderPolicy(md);
    for (const tag of ['ul', 'ol', 'li', 'p', 'h1', 'h2', 'strong', 'a']) {
      assert.equal((html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length,
        (html.match(new RegExp(`</${tag}>`, 'g')) || []).length, `<${tag}> is balanced`);
    }
    assert.equal((html.match(/<ol>/g) || []).length, 1, 'the seven things never allowed are one numbered list');
    assert.equal((/<ol>([\s\S]*)<\/ol>/.exec(html)[1].match(/<li>/g) || []).length, 7 + 3);
    assert.match(html, /<a href="\/licence">LICENSE<\/a>/);
    assert.match(html, /<a href="https:\/\/report\.cybertip\.org\/" rel="noopener noreferrer">/);

    const licence = fs.readFileSync(path.join(__dirname, '..', 'legal', 'LICENSE'), 'utf8');
    const lp = (await s.get('/licence')).body.toString('utf8');
    assert.ok(words(/<main[^>]*>([\s\S]*)<\/main>/.exec(lp)[1]).endsWith(words(licence.replace(/</g, '&lt;'))));
    assert.match(lp, /<h2>NO WARRANTY<\/h2>/);
  } finally { await s.close(); }
});

test('the sitemap lists what a visitor can reach', async () => {
  const s = await start();
  try {
    const xml = (await s.get('/sitemap.xml')).body.toString('utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
    assert.deepEqual(locs, visible(s.site).map((p) => ORIGIN + p.route).sort());
    assert.ok(!xml.includes('/404'));
    assert.match((await s.get('/robots.txt')).body.toString('utf8'), /Sitemap: https:\/\/workflowremix\.com\/sitemap\.xml/);
  } finally { await s.close(); }
});

test('sections list their pages in order, with the way on', async () => {
  const s = await start();
  try {
    const html = (await s.get('/docs/remix')).body.toString('utf8');
    assert.match(html, /<a href="\/docs\/remix" aria-current="page">Remixing a file<\/a>/);
    assert.match(html, /class="prev" href="\/docs\/browse"/);
    assert.match(html, /class="next" href="\/docs\/prompts"/);
    // The sidebar marks the place the page belongs to, and lists its section's pages
    // under it, the page itself marked; the phone's tab bar marks the same place.
    assert.match(html, /<a class="sb-item on" href="\/docs" aria-current="page"><svg [^>]+>.*?<\/svg><span>Docs<\/span><\/a>\n<ul class="sb-sub">/);
    assert.match(/<ul class="sb-sub">([\s\S]*?)<\/ul>/.exec(html)[1], /<a href="\/docs\/remix" aria-current="page">Remixing a file<\/a>/);
    assert.match(html, /<a class="tab-item on" href="\/docs" aria-current="page">/);
    assert.equal((html.match(/<ul class="sb-sub">/g) || []).length, 1, 'only the section the page is in is opened');
    const docs = s.site.pages.filter((p) => p.meta.section === 'docs').map((p) => Number(p.meta.order)).sort((a, b) => a - b);
    assert.deepEqual(docs, docs.map((_, i) => i), 'docs pages are numbered without a gap');
    const ex = (await s.get('/examples/collections')).body.toString('utf8');
    assert.match(ex, /<a class="sb-item on" href="\/examples" aria-current="page">/);
    const home = (await s.get('/')).body.toString('utf8');
    assert.match(home, /<a class="sb-item on" href="\/" aria-current="page">/);
    assert.ok(!home.includes('class="sb-sub"'), 'a page outside the sections opens none');
    assert.match(home, /<a class="tab-main" href="\/downloads">/, 'the raised tab is the way to the installers');
    assert.match(ex, /Fantasy World/);
  } finally { await s.close(); }
});
