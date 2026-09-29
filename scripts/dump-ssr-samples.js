// Dump per-store SSR product HTML for offline parser development.
const fs = require('fs');
const path = require('path');
const { ZeptoChecker } = require('../engine');

const PRODUCT = 'https://www.zepto.com/pn/surf-excel-matic-liquid-detergent-5-kg-for-top-load-removes-tough-stains-in-1st-wash/pvid/a3e1b947-86b8-4311-ab00-8b47928c8b0a';
const STORES = [
  { name: 'chennai', lat: 12.930555, lng: 80.232566 },
  { name: 'surat', lat: 21.173552, lng: 72.823647 },
];

(async () => {
  const outDir = path.join(__dirname, '..', 'data', 'samples');
  fs.mkdirSync(outDir, { recursive: true });
  const checker = new ZeptoChecker();
  await checker.launch();
  const { page, ctx } = checker;
  await checker.gotoWithRetry(PRODUCT);

  for (const s of STORES) {
    await ctx.addCookies([
      { name: 'latitude', value: String(s.lat), domain: '.zepto.com', path: '/' },
      { name: 'longitude', value: String(s.lng), domain: '.zepto.com', path: '/' },
      { name: 'user_position', value: JSON.stringify({ latitude: s.lat, longitude: s.lng }), domain: '.zepto.com', path: '/' },
    ]);
    await ctx.clearCookies({ name: 'serviceability' });
    const html = await page.evaluate(async u => await (await fetch(u, { credentials: 'include' })).text(), PRODUCT);
    const f = path.join(outDir, `${s.name}.html`);
    fs.writeFileSync(f, html);
    console.log(`${s.name}: ${html.length} bytes -> ${f}`);
    await page.waitForTimeout(800);
  }
  await checker.browser.close();
})().catch(e => { console.error(e); process.exit(1); });
