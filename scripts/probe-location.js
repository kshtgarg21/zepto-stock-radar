// Probe: how does zepto.com persist the selected delivery location?
// Sets one location via the normal modal flow, then dumps storage + captured API calls.
const path = require('path');
const fs = require('fs');
const { ZeptoChecker } = require('../engine');

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  const { page, ctx } = checker;

  const hits = [];
  page.on('request', req => {
    const u = req.url();
    if (/\.(js|css|png|jpe?g|svg|woff2?|ico|webp|gif)(\?|$)/i.test(u)) return;
    const isPost = req.method() === 'POST';
    const interesting = /zepto/i.test(u) && /(api|gql|graphql|location|address|store|serviceab|delivery)/i.test(u);
    if (isPost || interesting) {
      hits.push({
        method: req.method(),
        url: u.slice(0, 300),
        headers: pickHeaders(req.headers()),
        body: (req.postData() || '').slice(0, 600),
      });
    }
  });

  await checker.gotoWithRetry('https://www.zepto.com/');
  const before = await dumpStorage(page, ctx);

  const r = await checker.setLocation(['HSR Layout, Bangalore, Karnataka 560102', '560102']);
  console.log('setLocation:', JSON.stringify(r));
  await page.waitForTimeout(5000);

  const after = await dumpStorage(page, ctx);
  const out = {
    setLocation: r,
    storageDiff: diff(before, after),
    requests: hits,
  };
  const dest = path.join(__dirname, '..', 'data', 'probe-location.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2).slice(0, 6000));
  console.log(`\nfull dump -> ${dest}`);
  await checker.browser.close();
})().catch(e => { console.error(e); process.exit(1); });

function pickHeaders(h) {
  const keep = ['content-type', 'next-action', 'x-requested-with', 'referer'];
  return Object.fromEntries(Object.entries(h).filter(([k]) => keep.includes(k.toLowerCase())));
}

async function dumpStorage(page, ctx) {
  const local = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))).catch(() => ({}));
  const session = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))).catch(() => ({}));
  const cookies = (await ctx.cookies()).map(c => `${c.name}=${c.value.slice(0, 120)}`);
  return { local, session, cookies };
}

function diff(before, after) {
  const d = { localChanged: {}, sessionChanged: {}, cookiesAdded: [] };
  for (const [k, v] of Object.entries(after.local)) {
    if (before.local[k] !== v) d.localChanged[k] = String(v).slice(0, 400);
  }
  for (const [k, v] of Object.entries(after.session)) {
    if (before.session[k] !== v) d.sessionChanged[k] = String(v).slice(0, 400);
  }
  const b = new Set(before.cookies);
  d.cookiesAdded = after.cookies.filter(c => !b.has(c));
  return d;
}
