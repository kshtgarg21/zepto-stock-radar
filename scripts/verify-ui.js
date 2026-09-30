// Headless smoke test: does the dashboard render the session without JS errors?
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).split('\n')[0].slice(0, 140)));

  await page.goto('http://localhost:3456/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const home = await page.evaluate(() => ({
    rows: document.getElementById('tbody') ? document.getElementById('tbody').children.length : -1,
    card: getComputedStyle(document.getElementById('resultsCard')).display,
    startDisabled: document.getElementById('startBtn').disabled,
  }));
  console.log('HOMEPAGE  rows:', home.rows, '| results card:', home.card, '| startBtn disabled:', home.startDisabled);
  console.log('HOMEPAGE  pageerrors:', errors.length ? errors.join(' ;; ') : 'none');

  await page.goto('http://localhost:3456/sessions', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const list = await page.evaluate(() => ({
    rows: document.getElementById('tbody') ? document.getElementById('tbody').children.length : -1,
  }));
  console.log('SESSIONS  list rows:', list.rows, '| pageerrors:', errors.length ? errors.join(' ;; ') : 'none');

  await b.close();
})().catch(e => { console.log('FAIL:', e.message.split('\n')[0]); process.exit(1); });
