// Probe 5: in-page fetch of the SSR product HTML per store (browser network
// stack passes WAF). Find the price/availability keys in the RSC flight data.
const { ZeptoChecker } = require('../engine');

const PRODUCT = 'https://www.zepto.com/pn/surf-excel-matic-liquid-detergent-5-kg-for-top-load-removes-tough-stains-in-1st-wash/pvid/a3e1b947-86b8-4311-ab00-8b47928c8b0a';
const STORES = [
  { name: 'CHN-Sholinganallur New', lat: 12.930555, lng: 80.232566, city: 'Chennai' },
  { name: 'SUR-Majura Gate', lat: 21.173552, lng: 72.823647, city: 'Surat' },
];

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  const { page, ctx } = checker;
  await checker.gotoWithRetry(PRODUCT); // establishes session + WAF token

  for (const s of STORES) {
    await ctx.addCookies([
      { name: 'latitude', value: String(s.lat), domain: '.zepto.com', path: '/' },
      { name: 'longitude', value: String(s.lng), domain: '.zepto.com', path: '/' },
      { name: 'user_position', value: JSON.stringify({ latitude: s.lat, longitude: s.lng }), domain: '.zepto.com', path: '/' },
    ]);
    await ctx.clearCookies({ name: 'serviceability' });

    const out = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' });
      const html = await r.text();
      const res = { status: r.status, bytes: html.length, markers: {}, keys: [], snippets: [] };
      res.markers.addToCart = /Add to Cart/i.test(html);
      res.markers.soldOut = /sold out|out of stock|notify me/i.test(html);
      res.markers.storeClosed = /Store is Closed/i.test(html);
      res.markers.highDemand = /High Demand/i.test(html);
      const re = /\\?"(mrp|sellingPrice|discountedPrice|formattedPrice|price|outOfStock|available|sellable|notifyMe|inStock|availableQuantity|storeId|storeName|etaInMinutes|isDeliverable|serviceable)\\?"\s*:\s*(\\?"[^"\\]{0,60}\\?"|[\d.]+|true|false|null)/g;
      let m, n = 0;
      const seen = new Set();
      while ((m = re.exec(html)) && n++ < 200) {
        const kv = `${m[1]}=${m[2]}`;
        if (seen.has(kv)) continue;
        seen.add(kv);
        res.keys.push(kv);
        if (res.keys.length >= 50) break;
      }
      for (const needle of ['Add to Cart', '"mrp"', 'Store is Closed']) {
        const i = html.indexOf(needle);
        if (i >= 0) res.snippets.push(html.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' '));
      }
      return res;
    }, PRODUCT);

    console.log('='.repeat(100));
    console.log(`${s.name} — fetch status ${out.status}, ${out.bytes} bytes`);
    console.log('markers:', JSON.stringify(out.markers));
    console.log('keys:', JSON.stringify(out.keys, null, 1));
    out.snippets.forEach((sn, i) => console.log(`snippet[${i}]:`, sn));
    await page.waitForTimeout(800);
  }
  await checker.browser.close();
})().catch(e => { console.error(e); process.exit(1); });
