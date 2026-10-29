'use strict';

// Content pages for search: the free fixture tools, the blog (Markdown posts in
// content/blog), city pages that only exist where there's something to show,
// structured data that parses, and a sitemap that lists them all.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const blog = require('../server/blog');
const { TIERS } = require('../server/billing');

let db;
let svc;
let server;
let base;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  const app = createApp(db);
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});
const ORG = { user: { id: 1, email: 'seo@club.test', name: 'Org', isAdmin: false } };
const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
};
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/) || [])[1];
const canonicalOf = (html) => (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];

test('the tools, blog and posts are real pages with a title, canonical and structured data', async () => {
  const paths = ['/tools', '/tools/round-robin', '/tools/knockout-bracket', '/tools/split-by-level', '/blog', ...blog.posts().map((p) => p.path), `/blog/tag/${blog.tags()[0]}`];
  const titles = new Set();
  for (const p of paths) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.ok(titleOf(r.body), `${p}: title`);
    assert.ok(!titles.has(titleOf(r.body)), `${p}: duplicate title`);
    titles.add(titleOf(r.body));
    assert.equal(canonicalOf(r.body), base + p, `${p}: canonical`);
    const ld = ldOf(r.body);
    assert.ok(ld.some((x) => x['@type'] === 'BreadcrumbList'), `${p}: breadcrumbs`);
    assert.match(r.body, /<meta name="twitter:title"/);
  }
  const tool = await get('/tools/round-robin');
  assert.match(tool.body, /data-tool="round-robin"/);
  assert.match(tool.body, /<script src="\/formats.js"><\/script>/);
  assert.ok(ldOf(tool.body).some((x) => x['@type'] === 'FAQPage'));
  const post = await get('/blog/from-paper-to-live');
  const posting = ldOf(post.body).find((x) => x['@type'] === 'BlogPosting');
  assert.equal(posting.datePublished, '2026-10-29');
  assert.match(post.body, /class="paper-sheet paper-inline"/);
  assert.match(post.body, /<meta property="og:type" content="article">/);
  for (const p of ['/tools/nope', '/blog/nope', '/blog/tag/nope']) assert.equal((await get(p)).status, 404, p);
  const rss = await get('/blog/rss.xml');
  assert.match(rss.type, /rss/);
  assert.equal((rss.body.match(/<item>/g) || []).length, blog.posts().length);
});

test('blog posts: front matter is checked, Markdown is rendered and HTML is escaped', () => {
  assert.ok(blog.posts().length >= 6);
  assert.equal(blog.posts()[0].featured, true); // the featured post leads
  assert.throws(() => blog.parseFrontMatter('# no front matter', 'x.md'), /x.md: missing front matter/);
  assert.throws(() => blog.parseFrontMatter('---\ntitle: T\ndescription: D\n---\n', 'y.md'), /y.md: front matter needs "date"/);
  assert.throws(() => blog.parseFrontMatter('---\ntitle: T\ndescription: D\ndate: 29/10/2026\n---\n', 'z.md'), /date must be YYYY-MM-DD/);
  const { html, headings } = blog.markdown([
    '## First part', '', 'Some **bold**, *italic* and a [link](/tools) and [bad](javascript:alert) <script>x</script>', '',
    '- one', '- two', '', '| A | B |', '|---|---|', '| 1 | 2 |', '',
    ':::paper A sheet', 'INT: ~~Om~~ ==→ Ravi==', '((SF: A v B))', ':::', '',
    '![Groups](/guide/pools-{theme}.jpg "By level")',
  ].join('\n'));
  assert.deepEqual(headings, [{ id: 'first-part', text: 'First part' }]);
  assert.match(html, /<strong>bold<\/strong>, <em>italic<\/em>/);
  assert.match(html, /<a href="\/tools">link<\/a> and <a href="#">bad<\/a> &lt;script&gt;/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<th>A<\/th>.*<td>2<\/td>/);
  assert.match(html, /<s>Om<\/s> <span class="ink-red">→ Ravi<\/span>/);
  assert.match(html, /<span class="circled">SF: A v B<\/span>/);
  assert.match(html, /src="\/guide\/pools-dark.jpg".*src="\/guide\/pools-light.jpg".*<figcaption>By level/);
  // A bad file name or post fails loudly, naming the file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-'));
  fs.writeFileSync(path.join(dir, 'Bad Name.md'), '---\ntitle: T\ndescription: D\ndate: 2026-01-01\n---\n');
  assert.throws(() => blog.load(dir), /Bad Name.md: file names/);
});

test('every post links to pages that exist', async () => {
  const seen = new Set();
  for (const p of blog.posts()) {
    for (const [, href] of p.html.matchAll(/href="(\/[^"#?]*)/g)) {
      if (seen.has(href)) continue;
      seen.add(href);
      if (href.startsWith('/signup')) continue;
      assert.equal((await get(href)).status, 200, `${p.slug} links to ${href}`);
    }
    for (const [, src] of p.html.matchAll(/src="(\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', src)), `${p.slug}: ${src}`);
  }
});

test('city pages exist only where there is something to show', async () => {
  assert.equal((await get('/badminton/vellore')).status, 404);
  const make = (name) => svc.createTournament(ORG, { name, visibility: 'public', sport: 'badminton', city: 'Vellore', startsOn: '2026-12-01', events: [{ discipline: 'singles', gender: 'men' }] });
  await make('Vellore Open');
  assert.equal((await get('/badminton/vellore')).status, 404); // one isn't enough
  await make('Vellore Club Night');
  const r = await get('/badminton/vellore');
  assert.equal(r.status, 200);
  assert.match(titleOf(r.body), /Badminton Tournaments in Vellore/);
  assert.match(r.body, /Vellore Open/);
  assert.ok(ldOf(r.body).some((x) => x['@type'] === 'ItemList'));
  assert.equal((await get('/pickleball/vellore')).status, 404); // per sport
  // Listed on the sport page and in the sitemap.
  assert.match((await get('/badminton')).body, /href="\/badminton\/vellore"/);
  const map = (await get('/sitemap.xml')).body;
  for (const p of ['/badminton/vellore', '/tools/round-robin', '/blog', '/blog/from-paper-to-live', '/rankings']) assert.ok(map.includes(`<loc>${base}${p}</loc>`), p);
});

test('the fixture tools use the same draw code in the browser', () => {
  const ctx = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'formats.js'), 'utf8'), ctx);
  const F = ctx.self.TonamentFormats;
  assert.equal(F.roundRobin([1, 2, 3, 4, 5, 6, 7]).length, 7);
  assert.equal(JSON.stringify(F.knockoutSlots([1, 2, 3, 4, 5, 6].map((id) => ({ id, group: null, tier: 0 })))), '[1,null,4,5,2,null,3,6]');
  assert.equal(require('../server/formats').roundRobin, require('../public/formats').roundRobin);
});

test('pricing structured data matches the plans', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'pricing.html'), 'utf8');
  const app = ldOf(html).find((x) => x['@type'] === 'SoftwareApplication');
  const paid = app.offers.filter((o) => o.price > 0);
  assert.deepEqual(paid.map((o) => [o.name, o.price]), TIERS.map((t) => [t.name, t.price / 100]));
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public')).filter((x) => x.endsWith('.html'))) {
    ldOf(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')); // parses
  }
});
