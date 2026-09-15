const { chromium } = require('playwright');
const { EventEmitter } = require('events');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class ZeptoChecker extends EventEmitter {
  constructor() {
    super();
    this.stopped = false;
    this.browser = null;
  }

  stop() {
    this.stopped = true;
    if (this.browser) this.browser.close().catch(() => {});
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: false, // Zepto's bot protection blocks headless Chromium
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.ctx = await this.browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: 'en-IN',
    });
    await this.ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    this.page = await this.ctx.newPage();
  }

  async gotoWithRetry(url) {
    for (let a = 1; a <= 5; a++) {
      const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.page.waitForTimeout(6000);
      const title = await this.page.title();
      if (title && !title.startsWith('Access')) return;
      this.emit('log', `bot challenge, retrying (${a}/5)`);
      await this.page.waitForTimeout(4000);
    }
    throw new Error('Could not pass Zepto bot check after 5 attempts');
  }

  modalInput() {
    return this.page.locator('input[placeholder*="Search a new address" i]').first();
  }

  async modalInputVisible() {
    return await this.modalInput().isVisible().catch(() => false);
  }

  async openLocationModal() {
    if (await this.modalInputVisible()) return true;
    for (const [x, y] of [[300, 57], [250, 57]]) {
      await this.page.mouse.click(x, y).catch(() => {});
      await this.page.waitForTimeout(1700);
      if (await this.modalInputVisible()) return true;
    }
    try {
      await this.page.getByText('Select Location', { exact: false }).first().click({ timeout: 4000 });
      await this.page.waitForTimeout(1500);
      if (await this.modalInputVisible()) return true;
    } catch (e) { /* fall through */ }
    await this.gotoWithRetry(this.page.url());
    await this.page.mouse.click(300, 57).catch(() => {});
    await this.page.waitForTimeout(1700);
    return await this.modalInputVisible();
  }

  async setLocation(query) {
    if (!(await this.openLocationModal())) return { status: 'ERROR', info: 'modal-not-open' };
    const inp = this.modalInput();
    await inp.click().catch(() => {});
    await inp.fill('').catch(() => {});
    await inp.type(query, { delay: 50 }).catch(() => {});
    await this.page.waitForTimeout(2200);

    const items = this.page.locator('[data-testid="address-search-item"]');
    const cnt = await items.count().catch(() => 0);
    if (cnt === 0) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(800);
      return { status: 'NO_SUGGESTION' };
    }
    await items.first().click().catch(() => {});
    await this.page.waitForTimeout(2800);
    if (await this.modalInputVisible()) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(1000);
      if (await this.modalInputVisible()) return { status: 'ERROR', info: 'modal-still-open' };
    }
    await this.page.waitForTimeout(1500);
    return { status: 'SET' };
  }

  classify(text) {
    if (/Add to Cart/i.test(text)) return 'IN_STOCK';
    if (/we (?:are |'re )?not (?:at|in) your (?:location|area)|we don'?t deliver|not serviceable|coming soon to your|do not deliver/i.test(text)) return 'NO_SERVICE';
    if (/sold out|out of stock|currently unavailable|notify me/i.test(text)) return 'SOLD_OUT';
    return 'UNKNOWN';
  }

  extractPrice(text) {
    const m = text.match(/₹\s*\n?\s*(\d{6})\s*\n[\s\S]{0,60}?MRP\s*\n?\s*₹?\s*(\d{6})/);
    if (m) return `₹${m[1]} (MRP ₹${m[2]})`;
    const m2 = text.match(/₹\s*\n?\s*(\d{6})/);
    return m2 ? `₹${m2[1]}` : '';
  }

  async productName() {
    try {
      const ld = await this.page.$$eval('script[type="application/ld+json"]', els =>
        els.map(e => { try { return JSON.parse(e.textContent); } catch { return null; } })
      ).catch(() => []);
      const prod = ld.flat().find(o => o && o['@type'] === 'Product');
      if (prod && prod.name) return prod.name;
    } catch (e) { /* fall through */ }
    const t = await this.page.title();
    return t.replace(/ - Buy at .* - Zepto$/, '').trim() || t;
  }

  async run(url, items) {
    const results = [];
    try {
      await this.launch();
      this.emit('log', 'loading product page…');
      await this.gotoWithRetry(url);
      const name = await this.productName();
      this.emit('product', { name, url });

      for (const item of items) {
        if (this.stopped) break;
        try {
          const r = await this.setLocation(item.query);
          let row;
          if (r.status !== 'SET') {
            const mapped = r.status === 'NO_SUGGESTION' ? 'NO_SERVICE' : r.status;
            row = { label: item.label, status: mapped, price: '', info: r.info || '' };
          } else {
            const text = await this.page.evaluate(() => document.body ? document.body.innerText.replace(/\n{2,}/g, '\n').trim() : '');
            const status = this.classify(text);
            row = { label: item.label, status, price: status === 'IN_STOCK' ? this.extractPrice(text) : '', info: '' };
          }
          results.push(row);
          this.emit('result', row);
        } catch (e) {
          const row = { label: item.label, status: 'ERROR', price: '', info: (e.message || '').split('\n')[0].slice(0, 80) };
          results.push(row);
          this.emit('result', row);
          await this.page.waitForTimeout(2000);
        }
        await this.page.waitForTimeout(1000);
      }
      this.emit('done', { results, stopped: this.stopped });
    } catch (e) {
      this.emit('error', e.message || String(e));
    } finally {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    return results;
  }
}

module.exports = { ZeptoChecker };
