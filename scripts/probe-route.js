// Diagnose: does the route-based per-request cookie rewrite actually work?
// Logs whether the interceptor fires, what tag header it sees, and whether the
// response is store-specific (storeDetailedInfo present + matches our store).
const { ZeptoChecker } = require('../engine');

const PRODUCT = 'https://www.zepto.com/pn/apple-iphone-17-pro-256-gb-cosmic-orange/pvid/10c606fa-4327-4d32-a48a-2b05af2ecd3f';
const STORE = { idx: 0, name: 'CHN-Sholinganallur New', lat: 12.930555, lng: 80.232566 };

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  const { page, ctx } = checker;
  await checker.gotoWithRetry(PRODUCT);
  console.log('page loaded, title ok');

  let fired = 0;
  await page.route('**/pn/**', async route => {
    fired++;
    const req = route.request();
    console.log('--- route fired ---');
    console.log('url:', req.url().slice(0, 120));
    console.log('typeof headerValue:', typeof req.headerValue);
    let tag = null;
    try { tag = await req.headerValue('x-store-idx'); } catch (e) { console.log('headerValue threw:', e.message); }
    console.log('x-store-idx tag:', tag);
    const hdrs = req.headers();
    console.log('has cookie in req.headers():', 'cookie' in hdrs, '| headers:', Object.keys(hdrs).join(','));
    if (tag == null) return route.continue();

    const session = await ctx.cookies('https://www.zepto.com');
    console.log('ctx cookies:', session.map(c => c.name).join(', '));
    const jar = {};
    for (const c of session) {
      if (['latitude', 'longitude', 'user_position', 'serviceability'].includes(c.name)) continue;
      jar[c.name] = c.value;
    }
    jar.latitude = String(STORE.lat);
    jar.longitude = String(STORE.lng);
    jar.user_position = encodeURIComponent(JSON.stringify({ latitude: STORE.lat, longitude: STORE.lng }));
    const headers = { ...hdrs };
    delete headers['x-store-idx'];
    headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    console.log('injecting cookie header (first 200):', headers.cookie.slice(0, 200));
    await route.continue({ headers });
  });

  const out = await page.evaluate(async ({ url }) => {
    const r = await fetch(url + '?__z=0', { credentials: 'include', headers: { 'x-store-idx': '0' } });
    const html = await r.text();
    const un = html.replace(/\\"/g, '"');
    const sm = un.match(/"storeDetailedInfo":\{"city":"[^"]*","name":"([^"]+)"/);
    return { status: r.status, bytes: html.length, store: sm && sm[1], hasEta: /"etaInformation"/.test(un) };
  }, { url: PRODUCT });

  console.log('\nroute fired:', fired, 'time(s)');
  console.log('fetch result:', JSON.stringify(out));
  console.log(out.store === STORE.name ? 'PASS: response is for our store' : 'FAIL: response is NOT store-specific');
  await checker.browser.close();
})().catch(e => { console.error(e); process.exit(1); });
