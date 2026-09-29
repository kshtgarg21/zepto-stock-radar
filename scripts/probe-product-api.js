// Probe 3: find Zepto's product API. Loads a /pn/ page with location set by
// coords, captures every bff-gateway.zepto.com call (request headers +
// response body) to identify the endpoint carrying price/availability.
const { ZeptoChecker } = require('../engine');

const PRODUCT = 'https://www.zepto.com/pn/surf-excel-matic-liquid-detergent-5-kg-for-top-load-removes-tough-stains-in-1st-wash/pvid/a3e1b947-86b8-4311-ab00-8b47928c8b0a';
const STORE = { name: 'CHN-Sholinganallur New', lat: 12.930555, lng: 80.232566, city: 'Chennai' };

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  const { page, ctx } = checker;

  const calls = [];
  page.on('response', async res => {
    const u = res.url();
    if (!u.includes('bff-gateway.zepto.com')) return;
    let body = '';
    try { body = (await res.text()).slice(0, 4000); } catch (e) { body = `<unreadable: ${e.message}>`; }
    calls.push({ method: res.request().method(), url: u, status: res.status(), reqHeaders: res.request().headers(), body });
  });

  // establish a session, then set location to the Chennai dark store
  await checker.gotoWithRetry('https://www.zepto.com/');
  await page.evaluate(({ lat, lng, name, city }) => {
    let v;
    try { v = JSON.parse(localStorage.getItem('user-position')); } catch { v = null; }
    if (!v || !v.state) v = { state: {}, version: 0 };
    v.state.userPosition = {
      latitude: lat, longitude: lng, placeId: '', id: '',
      name, formattedAddress: `${name}, ${city}, India`, shortAddress: `${name}, ${city}`,
      googleMapsLocationData: { formattedAddress: `${name}, ${city}, India`, shortAddress: `${name}, ${city}` },
    };
    localStorage.setItem('user-position', JSON.stringify(v));
  }, STORE);
  await ctx.addCookies([
    { name: 'latitude', value: String(STORE.lat), domain: '.zepto.com', path: '/' },
    { name: 'longitude', value: String(STORE.lng), domain: '.zepto.com', path: '/' },
    { name: 'user_position', value: JSON.stringify({ latitude: STORE.lat, longitude: STORE.lng }), domain: '.zepto.com', path: '/' },
  ]);
  await ctx.clearCookies({ name: 'serviceability' });

  await checker.gotoWithRetry(PRODUCT);
  await page.waitForTimeout(3000);

  for (const c of calls) {
    console.log('='.repeat(100));
    console.log(c.method, c.url, `-> ${c.status}`);
    const hdrs = Object.fromEntries(
      Object.entries(c.reqHeaders).filter(([k]) => !/^(sec-|accept-encoding|accept-language|referer|origin|priority|cookie$|user-agent$|accept$)/i.test(k))
    );
    console.log('headers:', JSON.stringify(hdrs));
    console.log('body:', c.body.slice(0, 2500));
  }
  console.log(`\ntotal bff calls: ${calls.length}`);
  await checker.browser.close();
})().catch(e => { console.error(e); process.exit(1); });
