// Does the persistent profile's warm aws-waf-token pass the WAF
// while fresh browsers get ERR_HTTP_RESPONSE_CODE_FAILURE?
const { chromium } = require('playwright');

setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 90000);

(async () => {
  const ctx = await chromium.launchPersistentContext('data/browser-profile', {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-IN',
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    const resp = await page.goto('https://www.zepto.com/pn/apple-iphone-17-pro-256-gb-cosmic-orange/pvid/10c606fa-4327-4d32-a48a-2b05af2ecd3f', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    const title = await page.title();
    console.log('NAV OK | http:', resp && resp.status(), '| title:', title.slice(0, 70));
  } catch (e) {
    console.log('NAV FAILED:', e.message.split('\n')[0].slice(0, 90));
  }
  const cookies = (await ctx.cookies('https://www.zepto.com')).map(c => c.name);
  console.log('has aws-waf-token:', cookies.includes('aws-waf-token'));
  await ctx.close();
  process.exit(0);
})().catch(e => { console.log('FAIL:', e.message.split('\n')[0]); process.exit(1); });
