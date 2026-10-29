// Renders the app shortcut icons (the long-press menu on an installed app,
// listed in public/manifest.webmanifest): a navy rounded square with a lime
// line glyph, 96 px. Usage: node scripts/brand/shortcuts.js (needs Playwright)
const path = require('path');
const { chromium } = require('playwright');
const B = path.resolve(__dirname, '../../public/brand');
const NAVY = '#0B1220';
const LIME = '#A3E635';
const GLYPHS = {
  // New tournament: a plus.
  'shortcut-new': '<path d="M12 5v14M5 12h14"/>',
  // Your groups: two people.
  'shortcut-groups': '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.5" cy="9" r="2.4"/><path d="M15.5 14.2c2.6-.3 4.6 1.4 5 4.8"/>',
  // Rankings: a trophy.
  'shortcut-rankings': '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4"/>',
};
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 96, height: 96 } })).newPage();
  for (const [name, glyph] of Object.entries(GLYPHS)) {
    await p.setContent(`<html><body style="margin:0;background:transparent"><svg width="96" height="96" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
      <rect width="96" height="96" rx="22" fill="${NAVY}"/>
      <g transform="translate(22 22) scale(2.1667)" fill="none" stroke="${LIME}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg></body></html>`);
    await p.screenshot({ path: `${B}/${name}.png`, omitBackground: true, clip: { x: 0, y: 0, width: 96, height: 96 } });
  }
  await b.close();
})();
