// Renders brand SVGs to PNG sizes.
const { chromium } = require('playwright');
// Renders the brand SVGs to PNG icons, the email logo, og.png and og-features.png.
// Usage: node scripts/brand/render.js   (needs Playwright with Chromium)
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = path.resolve(__dirname, '../../public/brand');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tonament-brand-'));
// Pages must be real files: an about:blank page can't load file:// images.
const page = (name, html) => { const f = `${TMP}/${name}.html`; fs.writeFileSync(f, html); return 'file://' + f; };
const jobs = [['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512], ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512], ['favicon.svg', 'favicon-32.png', 32], ['favicon.svg', 'favicon-16.png', 16]];
(async () => {
  const b = await chromium.launch();
  for (const [src, out, size] of jobs) {
    const p = await (await b.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })).newPage();
    await p.goto(page(out, `<html><body style="margin:0;background:transparent"><img src="file://${B}/${src}" width="${size}" height="${size}" style="display:block"></body></html>`));
    await p.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
    await p.screenshot({ path: `${B}/${out}`, omitBackground: true });
  }
  // Email logo: white lockup on transparent background, 2x for retina (shown at 180x28)
  const p = await (await b.newContext({ viewport: { width: 360, height: 56 }, deviceScaleFactor: 1 })).newPage();
  await p.goto(page('email', `<html><body style="margin:0;background:transparent"><img src="file://${B}/logo-white.svg" height="56" style="display:block"></body></html>`));
  await p.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
  const box = await p.$eval('img', (i) => ({ w: i.getBoundingClientRect().width }));
  await p.setViewportSize({ width: Math.ceil(box.w), height: 56 });
  await p.screenshot({ path: `${B}/email-logo.png`, omitBackground: true });
  // Social preview (1200x630)
  const og = await (await b.newContext({ viewport: { width: 1200, height: 630 } })).newPage();
  await og.goto('file://' + path.join(__dirname, 'og.html'));
  await og.evaluate(() => document.fonts.ready);
  await og.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
  await og.screenshot({ path: `${B}/og.png` });
  // Social preview for the features page
  await og.goto('file://' + path.join(__dirname, 'og-features.html'));
  await og.evaluate(() => document.fonts.ready);
  await og.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await og.screenshot({ path: `${B}/og-features.png` });
  await b.close();
  // favicon.ico = 16 + 32 px PNGs
  const imgs = [`${B}/favicon-16.png`, `${B}/favicon-32.png`].map((f) => fs.readFileSync(f));
  const head = Buffer.alloc(6 + 16 * imgs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let offset = head.length;
  imgs.forEach((data, i) => {
    const size = [16, 32][i]; const o = 6 + 16 * i;
    head.writeUInt8(size, o); head.writeUInt8(size, o + 1); head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8); head.writeUInt32LE(offset, o + 12); offset += data.length;
  });
  fs.writeFileSync(path.resolve(B, '../favicon.ico'), Buffer.concat([head, ...imgs]));
  fs.unlinkSync(`${B}/favicon-16.png`);
})();
