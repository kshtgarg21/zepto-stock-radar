// Does headless Chromium pass Zepto's WAF on this residential IP?
// If yes, the checker can run headless — immune to window-close and more stable.
const { chromium } = require('playwright');

setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 100000);

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-IN',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  const url = 'https://www.zepto.com/pn/apple-iphone-17-pro-256-gb-cosmic-orange/pvid/10c606fa-4327-4d32-a48a-2b05af2ecd3f';
  try {
    for (let a = 1; a <= 3; a++) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(6000);
      const title = await page.title();
      console.log(`attempt ${a}: title = ${title.slice(0, 60)}`);
      if (title && !title.startsWith('Access')) {
        // confirm the SSR fetch path works too (that's what the checker uses)
        const html = await page.evaluate(async u => {
          const r = await fetch(u, { credentials: 'include' });
          return { status: r.status, len: (await r.text()).length };
        }, url);
        console.log('HEADLESS PASS | ssr fetch:', JSON.stringify(html));
        break;
      }
    }
  } catch (e) {
    console.log('HEADLESS FAILED:', e.message.split('\n')[0].slice(0, 90));
  }
  await browser.close();
  process.exit(0);
})().catch(e => { console.log('FAIL:', e.message.split('\n')[0]); process.exit(1); });
