// 429 experiment: what does Zepto rate-limit on — IP, session, or URL?
// Phase 1: pace requests at ~1.2s until first 429 (cap 150) -> trip point
// Phase 2: immediately try a FRESH session (new cookies) against the hot limit
// Phase 3: probe every 30s until 200 returns -> recovery window
// Phase 4: alternate two product URLs at the trip pace -> per-URL keying?
const { ZeptoChecker } = require('../engine');

const URL_A = 'https://www.zepto.com/pn/apple-iphone-17-pro-256-gb-cosmic-orange/pvid/10c606fa-4327-4d32-a48a-2b05af2ecd3f';
const URL_B = 'https://www.zepto.com/pn/surf-excel-matic-liquid-detergent-5-kg-for-top-load-removes-tough-stains-in-1st-wash/pvid/a3e1b947-86b8-4311-ab00-8b47928c8b0a';
const STORE = { lat: 12.930555, lng: 80.232566 };

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';

async function setStoreCookies(ctx) {
  await ctx.addCookies([
    { name: 'latitude', value: String(STORE.lat), domain: '.zepto.com', path: '/' },
    { name: 'longitude', value: String(STORE.lng), domain: '.zepto.com', path: '/' },
    { name: 'user_position', value: JSON.stringify({ latitude: STORE.lat, longitude: STORE.lng }), domain: '.zepto.com', path: '/' },
  ]);
  await ctx.clearCookies({ name: 'serviceability' });
}

async function fetchStatus(page, url) {
  return page.evaluate(async u => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, bytes: (await r.text()).length };
    } catch (e) { return { status: 0, error: String(e).slice(0, 50) }; }
  }, url);
}

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  const ctxA = checker.ctx;
  const pageA = checker.page;
  await checker.gotoWithRetry(URL_A);
  console.log(`[${elapsed()}] session A warm`);

  // ---- Phase 1: trip the limit ----
  console.log('\n=== PHASE 1: pacing ~1.2s until first 429 (cap 150) ===');
  let tripAt = null, tripCount = 0;
  for (let i = 1; i <= 150; i++) {
    await setStoreCookies(ctxA);
    const r = await fetchStatus(pageA, URL_A);
    tripCount = i;
    if (i % 10 === 0 || r.status !== 200) console.log(`[${elapsed()}] req ${i}: ${r.status} (${r.bytes || 0}b)`);
    if (r.status === 429) { tripAt = Date.now(); console.log(`[${elapsed()}] *** 429 at request #${i} ***`); break; }
    if (r.status === 0) { console.log(`[${elapsed()}] network error: ${r.error}`); break; }
    await pageA.waitForTimeout(1200);
  }
  if (!tripAt) {
    console.log(`[${elapsed()}] no 429 after ${tripCount} requests at ~1.2s — limit is higher than that`);
  }

  // ---- Phase 2: fresh session vs hot limit ----
  console.log('\n=== PHASE 2: does a FRESH session bypass the 429? ===');
  const ctxB = await checker.browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-IN',
  });
  const pageB = await ctxB.newPage();
  try {
    await pageB.goto(URL_A, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pageB.waitForTimeout(6000);
    await setStoreCookies(ctxB);
    const rb = await fetchStatus(pageB, URL_A);
    console.log(`[${elapsed()}] fresh session B fetch: ${rb.status} (${rb.bytes || 0}b) -> ${rb.status === 200 ? 'LIMIT IS PER-SESSION (rotation works!)' : 'fresh session also limited'}`);
    if (tripAt) {
      const ra = await fetchStatus(pageA, URL_A);
      console.log(`[${elapsed()}] old session A fetch: ${ra.status} -> ${ra.status === 429 ? 'A still throttled (per-session evidence)' : 'A recovered already'}`);
    }
  } catch (e) {
    console.log(`[${elapsed()}] session B navigation failed: ${(e.message || '').split('\n')[0].slice(0, 70)}`);
  }

  // ---- Phase 3: recovery window ----
  console.log('\n=== PHASE 3: recovery window (probe every 30s, cap 8 min) ===');
  let recovered = false;
  for (let i = 1; i <= 16; i++) {
    await pageA.waitForTimeout(30000);
    const r = await fetchStatus(pageA, URL_A);
    console.log(`[${elapsed()}] probe ${i}: ${r.status}`);
    if (r.status === 200) {
      console.log(`[${elapsed()}] recovered after ~${((Date.now() - (tripAt || t0)) / 1000).toFixed(0)}s from first 429`);
      recovered = true;
      break;
    }
  }
  if (!recovered) console.log(`[${elapsed()}] still throttled after 8 minutes`);

  // ---- Phase 4: per-URL keying ----
  if (recovered) {
    console.log('\n=== PHASE 4: alternate two product URLs at 1.2s, 40 requests ===');
    let a429 = 0, b429 = 0;
    for (let i = 1; i <= 40; i++) {
      const url = i % 2 ? URL_A : URL_B;
      await setStoreCookies(ctxA);
      const r = await fetchStatus(pageA, url);
      if (r.status === 429) { (i % 2 ? a429++ : b429++); console.log(`[${elapsed()}] req ${i} (${i % 2 ? 'A' : 'B'}): 429`); }
      await pageA.waitForTimeout(1200);
    }
    console.log(`[${elapsed()}] 429s: product A=${a429}, product B=${b429} -> ${a429 + b429 === 0 ? 'no limit at combined 2-url rate' : 'shared or per-url budget'}`);
  }

  await ctxB.close().catch(() => {});
  await checker.browser.close();
  console.log('\nexperiment done');
})().catch(e => { console.error(e); process.exit(1); });
