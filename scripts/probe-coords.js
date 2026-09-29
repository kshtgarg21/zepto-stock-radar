// Probe 2: can we set Zepto's location directly by lat/lng (no address modal)?
// For each dark store: (A) call store-resolution API at its coords,
// (B) write localStorage + cookies, reload a product page, read the result.
const { ZeptoChecker } = require('../engine');

const STORES = [
  { name: 'CHN-Sholinganallur New', lat: 12.930555, lng: 80.232566, city: 'Chennai' },
  { name: 'SUR-Majura Gate', lat: 21.173552, lng: 72.823647, city: 'Surat' },
];

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  const { page, ctx } = checker;
  await checker.gotoWithRetry('https://www.zepto.com/');

  const href = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/pn/"]');
    return a ? a.href : null;
  });
  console.log('product link:', href);

  for (const s of STORES) {
    // (A) store-resolution API at the store's coordinates (in-page fetch: real browser stack + cookies)
    const api = await page.evaluate(async ({ lat, lng }) => {
      try {
        const r = await fetch(`https://bff-gateway.zepto.com/api/v1/user/customer/address/location?latitude=${lat}&longitude=${lng}`, { credentials: 'include' });
        return { status: r.status, body: (await r.text()).slice(0, 2000) };
      } catch (e) { return { error: String(e) }; }
    }, s);
    console.log(`\n=== ${s.name} (${s.lat}, ${s.lng}) — address/location API ===`);
    console.log(JSON.stringify(api, null, 2));

    // (B) set location by coords, reload product page
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
    }, s);
    await ctx.addCookies([
      { name: 'latitude', value: String(s.lat), domain: '.zepto.com', path: '/' },
      { name: 'longitude', value: String(s.lng), domain: '.zepto.com', path: '/' },
      { name: 'user_position', value: JSON.stringify({ latitude: s.lat, longitude: s.lng }), domain: '.zepto.com', path: '/' },
    ]);
    await ctx.clearCookies({ name: 'serviceability' });

    if (href) {
      await checker.gotoWithRetry(href);
      const info = await page.evaluate(() => {
        const text = document.body ? document.body.innerText.replace(/\n{2,}/g, '\n').trim() : '';
        return { title: document.title, snippet: text.slice(0, 500) };
      });
      console.log(`--- ${s.name} — product page after coord-set ---`);
      console.log('title:', info.title);
      console.log('classify:', checker.classify(info.snippet));
      console.log('page start:', JSON.stringify(info.snippet.slice(0, 260)));
    }
  }
  await checker.browser.close();
})().catch(e => { console.error(e); process.exit(1); });
