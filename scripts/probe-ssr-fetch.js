// Probe 4: can we fetch the SSR product page HTML directly (no page render)
// per store? Establish WAF/session via one real page load, then re-fetch the
// product URL through ctx.request with per-store lat/lng cookies and look for
// price/availability keys in the embedded payload.
const { ZeptoChecker } = require('../engine');

const PRODUCT = 'https://www.zepto.com/pn/surf-excel-matic-liquid-detergent-5-kg-for-top-load-removes-tough-stains-in-1st-wash/pvid/a3e1b947-86b8-4311-ab00-8b47928c8b0a';
const STORES = [
  { name: 'CHN-Sholinganallur New', lat: 12.930555, lng: 80.232566, city: 'Chennai' },
  { name: 'SUR-Majura Gate', lat: 21.173552, lng: 72.823647, city: 'Surat' },
];

const KEYS = /"(sellingPrice|mrp|discountedPrice|selling_price|outOfStock|out_of_stock|available|sellable|notifyMe|inStock|inventory|quantity|storeId|store_id|isDeliverable|etaInMinutes)"\s*:\s*("[^"]*"|[\d.]+|true|false|null)/g;

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  const { page, ctx } = checker;

  // 1) pass bot check + establish session on the real product page
  await checker.gotoWithRetry(PRODUCT);
  const inPage = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const out = { nextData: !!document.getElementById('__NEXT_DATA__'), matches: [] };
    const re = /"(sellingPrice|mrp|discountedPrice|outOfStock|available|sellable|notifyMe|storeId|isDeliverable|etaInMinutes)"\s*:\s*("[^"]*"|[\d.]+|true|false|null)/g;
    let m, n = 0;
    while ((m = re.exec(html)) && n++ < 40) out.matches.push(`${m[1]}=${m[2]}`);
    return out;
  });
  console.log('=== live page (Chennai, rendered) ===');
  console.log('has __NEXT_DATA__:', inPage.nextData);
  console.log('key matches:', JSON.stringify(inPage.matches, null, 1));

  // 2) per store: raw HTTP fetch of the same URL with that store's cookies
  for (const s of STORES) {
    await ctx.clearCookies({ name: 'serviceability' });
    const cookieHeader = [
      `latitude=${s.lat}`,
      `longitude=${s.lng}`,
      `user_position=${encodeURIComponent(JSON.stringify({ latitude: s.lat, longitude: s.lng }))}`,
    ].join('; ');
    const res = await ctx.request.get(PRODUCT, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Cookie: cookieHeader,
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: 30000,
    });
    const html = await res.text();
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '(no title)';
    const matches = [];
    let m, n = 0;
    while ((m = KEYS.exec(html)) && n++ < 60) matches.push(`${m[1]}=${m[2]}`);
    KEYS.lastIndex = 0;
    const addToCart = /Add to Cart/i.test(html);
    const soldOut = /sold out|out of stock|notify me/i.test(html);
    const closed = /store is closed/i.test(html);
    console.log(`\n=== raw fetch: ${s.name} (${s.lat}, ${s.lng}) ===`);
    console.log('status:', res.status(), '| html bytes:', html.length, '| title:', title.slice(0, 90));
    console.log('markers: AddToCart=' + addToCart, 'soldOut=' + soldOut, 'storeClosed=' + closed);
    console.log('key matches:', JSON.stringify(matches, null, 1));
  }
  await checker.browser.close();
})().catch(e => { console.error(e); process.exit(1); });
