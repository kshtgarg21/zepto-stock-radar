// End-to-end feature verification: exercises every UI feature headlessly.
// Usage: node scripts/verify-features.js
const { chromium } = require('playwright');

const BASE = 'http://localhost:3456';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).split('\n')[0].slice(0, 120)));

  // --- dashboard ---
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const dash = await page.evaluate(() => ({
    rows: document.getElementById('tbody').children.length,
    chips: document.querySelectorAll('#statusChips .chip').length,
    sessionLink: document.getElementById('sessionLink').style.display,
    sessionText: document.getElementById('sessionLink').textContent,
    logLines: document.getElementById('log').children.length,
    url: location.href,
  }));
  check('dashboard renders results', dash.rows > 0, dash.rows + ' rows');
  check('status filter chips render', dash.chips >= 3, dash.chips + ' chips');
  check('session link shown', dash.sessionLink === 'block' && /Session S/.test(dash.sessionText), dash.sessionText.slice(0, 40));
  check('session id in URL', /[?&]session=S/.test(dash.url), dash.url);
  check('fetch log lines accumulated', dash.logLines > 0, dash.logLines + ' lines');
  check('no page errors on dashboard', errors.length === 0, errors.join('; ').slice(0, 120));

  // --- chip filter interaction ---
  if (dash.chips >= 3) {
    const before = await page.evaluate(() => [...document.getElementById('tbody').children].filter(t => t.style.display !== 'none').length);
    await page.evaluate(() => { [...document.querySelectorAll('#statusChips .chip')].find(c => c.textContent.startsWith('In stock'))?.click(); });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => [...document.getElementById('tbody').children].filter(t => t.style.display !== 'none').length);
    const inStock = await page.evaluate(() => document.querySelectorAll('#statusChips .chip.on').length);
    check('chip click toggles filter', after <= before && inStock === 1, `${before} -> ${after}`);
    await page.evaluate(() => { [...document.querySelectorAll('#statusChips .chip')].find(c => c.textContent.startsWith('In stock'))?.click(); });
    await page.waitForTimeout(300);
  }

  // --- sessions list + view ---
  await page.goto(BASE + '/sessions', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const list = await page.evaluate(() => ({
    rows: document.getElementById('tbody').children.length,
    viewLink: !!document.querySelector('a[href^="/session/"]'),
  }));
  check('sessions list renders', list.rows >= 1, list.rows + ' sessions');
  check('session view link present', list.viewLink);

  if (list.viewLink) {
    const href = await page.evaluate(() => document.querySelector('a[href^="/session/"]').getAttribute('href'));
    await page.goto(BASE + href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const view = await page.evaluate(() => ({
      rows: document.getElementById('viewTbody').children.length,
      resumeBtn: !!document.getElementById('resumeGaps'),
    }));
    check('session view renders rows', view.rows > 0, view.rows + ' rows');
    check('session view has resume button', view.resumeBtn);
  }

  // --- API endpoints ---
  const csv = await page.evaluate(async () => {
    const r = await fetch('/api/csv');
    const t = await r.text();
    return { ok: r.ok, lines: t.split('\n').length, header: t.split('\n')[0] };
  });
  check('CSV export works', csv.ok && csv.lines > 1 && /location,product,status/.test(csv.header), csv.lines + ' lines');
  check('no page errors at end', errors.length === 0, errors.join('; ').slice(0, 120));

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('HARNESS FAIL:', e.message.split('\n')[0]); process.exit(1); });