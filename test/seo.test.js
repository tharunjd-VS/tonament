'use strict';

// Search and sharing: server-rendered tournament pages (/t/<id>) with link
// previews and event data, the sitemap, robots.txt and real 404s.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

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

const ORG = { user: { id: 1, email: 'org@seo.test', name: 'Org', isAdmin: false } };
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`img-${n}`)]).toString('base64');
const meta = (html, name) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)">`));
  return m && m[1];
};
const ld = (html) => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return m && JSON.parse(m[1]);
};
const get = async (path) => {
  const res = await fetch(base + path);
  return { res, html: await res.text() };
};

async function diwali(extra = {}) {
  const { id } = await svc.createTournament(ORG, {
    name: 'Diwali "Smash" <Open>', visibility: 'public', venue: 'City Sports Hall', address: '19th Cross Street',
    city: 'Chennai', region: 'Tamil Nadu', postcode: '600041', country: 'India', startsOn: '2030-11-02', endsOn: '2030-11-03',
    events: [{ discipline: 'singles', gender: 'men' }, { discipline: 'doubles', gender: 'mixed' }],
    ...extra,
  });
  return id;
}

test('a public tournament page: details, preview tags and event data', async () => {
  const id = await diwali();
  const t = await svc.getTournament(id, ORG);
  await svc.updateEvent(id, ORG, t.events[0].id, { prizes: [{ place: 'winner', cash: 5000, reward: 'Trophy' }] });
  await svc.updateSettings(id, ORG, { about: 'Our yearly </script> open.', perks: { items: ['water', 'lunch'] } });

  const { res, html } = await get(`/t/${id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('cache-control'), /s-maxage=60/);
  // The app page, with the tournament in the head and the body.
  assert.ok(html.includes('<script src="/app.js"></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="/styles.css">')); // the page keeps its styles and icons
  assert.ok(html.includes('rel="manifest"'));
  assert.match(html, /<title>Diwali &quot;Smash&quot; &lt;Open&gt; — Badminton tournament in Chennai · Tonament<\/title>/);
  assert.equal(meta(html, 'description'),
    'Sat 2 – Sun 3 Nov 2030 · City Sports Hall, Chennai · Badminton: Men&#39;s Singles, Mixed Doubles · 🏆 ₹5,000 in prizes · Entries open');
  assert.match(html, new RegExp(`<link rel="canonical" href="${base}/t/${id}">`));
  assert.equal(meta(html, 'robots'), null);
  assert.equal(meta(html, 'og:title'), 'Diwali &quot;Smash&quot; &lt;Open&gt;');
  assert.equal(meta(html, 'og:image'), `${base}/brand/og.png`);
  assert.equal(html.match(/<link rel="canonical"/g).length, 1); // the home page's is replaced
  assert.ok(html.includes('<div class="prerender">'));
  assert.match(html, /<h1>Diwali &quot;Smash&quot; &lt;Open&gt;<\/h1>/);
  for (const text of ['City Sports Hall', '19th Cross Street', 'Men&#39;s Singles', 'Winner: ₹5,000 + Trophy', 'Drinking water', 'Our yearly &lt;/script&gt; open.']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('Run your tournament. Score every point live.')); // not the home page's content

  const data = ld(html);
  assert.equal(data['@type'], 'SportsEvent');
  assert.equal(data.name, 'Diwali "Smash" <Open>');
  assert.deepEqual([data.startDate, data.endDate, data.sport], ['2030-11-02', '2030-11-03', 'Badminton']);
  assert.deepEqual(data.location, {
    '@type': 'Place', name: 'City Sports Hall',
    address: { '@type': 'PostalAddress', streetAddress: '19th Cross Street', addressLocality: 'Chennai', addressRegion: 'Tamil Nadu', postalCode: '600041', addressCountry: 'India' },
  });
  assert.deepEqual(data.offers, { '@type': 'Offer', price: 0, priceCurrency: 'INR', availability: 'https://schema.org/InStock', url: `${base}/t/${id}` });
  assert.ok(!html.includes('</script> open')); // nothing in the JSON closes its script tag

  // Tabs and matches share the canonical; match pages aren't indexed.
  assert.match((await get(`/t/${id}/courts?e=5`)).html, new RegExp(`<link rel="canonical" href="${base}/t/${id}">`));
  const match = (await get(`/t/${id}/m/12`)).html;
  assert.equal(meta(match, 'robots'), 'noindex');
  assert.equal(ld(match), null);
  // Vercel's rewrite of /t/* reaches the same page.
  assert.match((await get(`/api/index?__path=share/${id}/live&e=7`)).html, /<h1>Diwali/);
});

test('preview images: the cover, then its 1200×630 copy', async () => {
  const id = await diwali({ name: 'Cover Cup' });
  await svc.uploadMedia(id, ORG, { kind: 'cover', data: jpeg('cover') });
  const cover = (await svc.getTournament(id)).cover;
  let html = (await get(`/t/${id}`)).html;
  assert.equal(meta(html, 'og:image'), base + cover);
  assert.equal(meta(html, 'og:image:width'), null);
  assert.deepEqual(ld(html).image, [base + cover]);
  await svc.uploadMedia(id, ORG, { kind: 'preview', data: jpeg('preview') });
  html = (await get(`/t/${id}`)).html;
  assert.notEqual(meta(html, 'og:image'), base + cover);
  assert.equal(meta(html, 'og:image:width'), '1200');
  assert.equal((await svc.getTournament(id, ORG)).photos.length, 0); // the preview isn't a photo
  // A new cover drops the old preview.
  await svc.uploadMedia(id, ORG, { kind: 'cover', data: jpeg('cover2') });
  assert.equal(meta((await get(`/t/${id}`)).html, 'og:image:width'), null);
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'preview', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(700 * 1024)]).toString('base64') }), /under 600 KB/);
});

test('no event data without a date and place; link-only and private pages are never indexed', async () => {
  const timed = await diwali({ name: 'Morning Cup', startTime: '08:00', endTime: '18:30' });
  const timedPage = (await get(`/t/${timed}`)).html;
  assert.match(meta(timedPage, 'description'), /^Sat 2 – Sun 3 Nov 2030 · 8:00 AM – 6:30 PM · City Sports Hall/);
  assert.deepEqual([ld(timedPage).startDate, ld(timedPage).endDate], ['2030-11-02T08:00', '2030-11-03T18:30']);

  const undated = await diwali({ name: 'Someday Cup', startsOn: undefined, endsOn: undefined });
  const html = (await get(`/t/${undated}`)).html;
  assert.equal(ld(html), null);
  assert.match(html, /<h1>Someday Cup<\/h1>/);

  const link = await diwali({ name: 'Club Night', visibility: 'link' });
  const linkPage = await get(`/t/${link}`);
  assert.equal(meta(linkPage.html, 'robots'), 'noindex');
  assert.equal(ld(linkPage.html), null);
  assert.match(linkPage.html, /<h1>Club Night<\/h1>/); // people with the link still see it

  const { id: secret } = await svc.createTournament(ORG, { name: 'Secret Cup' });
  const priv = await get(`/t/${secret}`);
  assert.equal(priv.res.status, 200); // the team opens it in the app
  assert.equal(priv.res.headers.get('cache-control'), 'no-store');
  assert.equal(meta(priv.html, 'robots'), 'noindex');
  assert.ok(!priv.html.includes('Secret Cup'));
  assert.ok(!priv.html.includes('prerender'));

  const missing = await get('/t/no-such-cup');
  assert.equal(missing.res.status, 404);
  assert.equal(meta(missing.html, 'robots'), 'noindex');
});

test('sitemap, robots.txt, app routes and real 404s', async () => {
  const pub = await diwali({ name: 'Mapped Cup' });
  const link = await diwali({ name: 'Unmapped Cup', visibility: 'link' });
  let { res, html: xml } = await get('/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  assert.ok(xml.includes(`<loc>${base}/t/${pub}</loc>`));
  assert.ok(!xml.includes(link));
  assert.ok(xml.includes(`<loc>${base}/pricing</loc>`));
  assert.ok(xml.includes(`<loc>${base}/how-it-works</loc>`) && xml.includes(`<loc>${base}/faq</loc>`));
  assert.ok(xml.includes(`<loc>${base}/features</loc>`));
  assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.ok((await get('/api/index?__path=sitemap')).html.includes(`/t/${pub}`));

  ({ res, html: xml } = await get('/robots.txt'));
  assert.equal(res.status, 200);
  assert.match(xml, /Sitemap: https:\/\/tonament\.com\/sitemap\.xml/);

  for (const path of ['/new', '/signin', '/reset', '/admin']) {
    const page = await get(path);
    assert.equal(page.res.status, 200, path);
    assert.ok(page.html.includes('<script src="/app.js"></script>'), path);
  }
  const home = await get('/');
  assert.match(home.html, /<h1>Run your tournament\. Score every point live\.<\/h1>/);
  assert.match(home.html, /"@type":"Organization"/);
  const nope = await get('/no-such-page');
  assert.equal(nope.res.status, 404);
  assert.match(nope.html, /Page not found/);
  assert.equal((await get('/pricing')).res.status, 200);
});

test('Features page', async () => {
  const page = await get('/features');
  assert.equal(page.res.status, 200);
  assert.match(page.html, /<link rel="canonical" href="https:\/\/tonament\.com\/features">/);
  // Sign-up buttons lead on to creating a tournament.
  assert.ok(page.html.includes('href="/signup?next=%2Fnew"'));
  for (const src of new Set([...page.html.matchAll(/src="(\/guide\/[^"]+)"/g)].map((m) => m[1]))) {
    assert.equal((await fetch(base + src)).status, 200, src);
  }
});

test('How it works and FAQ pages', async () => {
  const how = await get('/how-it-works');
  assert.equal(how.res.status, 200);
  assert.match(how.html, /<h1>How Tonament works<\/h1>/);
  assert.match(how.html, /<link rel="canonical" href="https:\/\/tonament\.com\/how-it-works">/);
  // Each screenshot comes in both themes, and every image exists.
  const images = [...how.html.matchAll(/src="(\/guide\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(images.length >= 20);
  assert.equal(images.filter((x) => x.endsWith('-dark.jpg')).length, images.filter((x) => x.endsWith('-light.jpg')).length);
  for (const src of new Set(images)) assert.equal((await fetch(base + src)).status, 200, src);
  assert.ok(!/<img(?![^>]*\balt=")[^>]*>/.test(how.html)); // every image has alt text

  const faq = await get('/faq');
  assert.equal(faq.res.status, 200);
  const data = ld(faq.html);
  assert.equal(data['@type'], 'FAQPage');
  const questions = [...faq.html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.equal(data.mainEntity.length, questions.length);
  assert.ok(questions.length >= 20);
  for (const q of data.mainEntity) {
    assert.equal(q['@type'], 'Question');
    assert.ok(q.acceptedAnswer.text.length > 20 && !/</.test(q.acceptedAnswer.text), q.name); // plain text
  }
});
