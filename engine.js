const { chromium } = require('playwright');
const { EventEmitter } = require('events');
const { parseSsrProduct, cleanProductName, shareProductName } = require('./ssr-parse');

const pvidOf = u => ((u || '').match(/pvid\/([0-9a-f-]+)/) || [])[1];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class ZeptoChecker extends EventEmitter {
  constructor() {
    super();
    this.stopped = false;
    this.browser = null;
    this.throttle = { until: 0, fails: 0 }; // shared 429 cooldown across workers
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
    this.ctx = await this.newSession();
    this.page = await this.ctx.newPage();
  }

  // An isolated session (own cookie jar) — parallel workers each get one.
  async newSession() {
    const ctx = await this.browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: 'en-IN',
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return ctx;
  }

  async gotoWithRetry(url, page = this.page) {
    let lastErr = null;
    for (let a = 1; a <= 6; a++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(6000);
        const title = await page.title();
        if (title && !title.startsWith('Access')) return;
        this.emit('log', `bot challenge, retrying (${a}/6)`);
      } catch (e) {
        // WAF throttling answers navigations with an error-status page
        // (net::ERR_HTTP_RESPONSE_CODE_FAILURE) — back off and retry.
        lastErr = e;
        this.emit('log', `navigation blocked (${(e.message || '').split('\n')[0].slice(0, 50)}), retry ${a}/6…`);
      }
      await this.page.waitForTimeout(4000 + a * 3000);
    }
    throw lastErr || new Error('Could not pass Zepto bot check after 6 attempts');
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

  async setLocation(queries) {
    if (!(await this.openLocationModal())) return { status: 'ERROR', info: 'modal-not-open' };
    const inp = this.modalInput();
    for (const q of queries) {
      await inp.click().catch(() => {});
      await inp.fill('').catch(() => {});
      await inp.type(q, { delay: 25 }).catch(() => {});
      await this.page.waitForTimeout(2200);

      const items = this.page.locator('[data-testid="address-search-item"]');
      const cnt = await items.count().catch(() => 0);
      if (cnt === 0) continue; // try next query in the fallback chain

      await items.first().click().catch(() => {});
      await this.page.waitForTimeout(2800);
      if (await this.modalInputVisible()) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(1000);
        if (await this.modalInputVisible()) return { status: 'ERROR', info: 'modal-still-open' };
      }
      await this.page.waitForTimeout(1500);
      return { status: 'SET', via: q };
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(800);
    return { status: 'NO_SUGGESTION' };
  }

  // Set the delivery location directly from coordinates: Zepto persists the
  // picked address in localStorage["user-position"] and latitude/longitude
  // cookies, so writing those + reloading resolves the exact dark store.
  async setLocationByCoords({ lat, lng, name, city }, url) {
    try {
      await this.page.evaluate(({ lat, lng, name, city }) => {
        let v;
        try { v = JSON.parse(localStorage.getItem('user-position')); } catch { v = null; }
        if (!v || !v.state) v = { state: {}, version: 0 };
        v.state.userPosition = {
          latitude: lat, longitude: lng, placeId: '', id: '',
          name: name || `${lat},${lng}`,
          formattedAddress: `${name || 'Location'}, ${city || ''}, India`,
          shortAddress: `${name || 'Location'}, ${city || ''}`,
          googleMapsLocationData: {
            formattedAddress: `${name || 'Location'}, ${city || ''}, India`,
            shortAddress: `${name || 'Location'}, ${city || ''}`,
          },
        };
        localStorage.setItem('user-position', JSON.stringify(v));
      }, { lat, lng, name, city });
      await this.ctx.addCookies([
        { name: 'latitude', value: String(lat), domain: '.zepto.com', path: '/' },
        { name: 'longitude', value: String(lng), domain: '.zepto.com', path: '/' },
        { name: 'user_position', value: JSON.stringify({ latitude: lat, longitude: lng }), domain: '.zepto.com', path: '/' },
      ]);
      await this.ctx.clearCookies({ name: 'serviceability' }); // stale store resolution would confuse SSR
      await this.gotoWithRetry(url || this.productUrl);
      return { status: 'SET', via: `${lat},${lng}` };
    } catch (e) {
      return { status: 'ERROR', info: (e.message || '').split('\n')[0].slice(0, 80) };
    }
  }

  // Fast per-store check: fetch the SSR product HTML from inside the live
  // page (the browser's network stack passes the WAF; plain Node requests
  // get a 202 challenge) and parse the embedded flight data for exact
  // price + stock quantity. ~1s per store vs ~9s for a full page reload.
  async checkStoreViaFetch({ lat, lng, name, city, label }, url) {
    url = url || this.productUrls[0];
    await this.ctx.addCookies([
      { name: 'latitude', value: String(lat), domain: '.zepto.com', path: '/' },
      { name: 'longitude', value: String(lng), domain: '.zepto.com', path: '/' },
      { name: 'user_position', value: JSON.stringify({ latitude: lat, longitude: lng }), domain: '.zepto.com', path: '/' },
    ]);
    await this.ctx.clearCookies({ name: 'serviceability' });
    const html = await this.page.evaluate(async u => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error(`http-${r.status}`);
      return await r.text();
    }, url);
    const p = parseSsrProduct(html, pvidOf(url));
    if (p.name && !this.productNames[url]) {
      this.productNames[url] = p.name;
      this.emit('product', { url, name: p.name });
    }
    if (!p.foundProduct && p.status !== 'NO_SERVICE') {
      // payload shape changed or bad fetch — fall back to render + classify
      this.emit('log', `${label}: SSR parse miss, falling back to page render`);
      const r = await this.setLocationByCoords({ lat, lng, name, city }, url);
      if (r.status !== 'SET') return { label, product: this.productLabel(url), purl: url, status: 'ERROR', price: '', info: r.info || '' };
      const text = await this.page.evaluate(() => document.body ? document.body.innerText.replace(/\n{2,}/g, '\n').trim() : '');
      const status = this.classify(text);
      const banner = this.extractBanner(text);
      return { label, product: this.productLabel(url), purl: url, status, price: status === 'IN_STOCK' ? this.extractPrice(text) : '', info: ['via: page-render', banner].filter(Boolean).join('; ') };
    }
    return ZeptoChecker.rowFromParsed(label, this.productLabel(url), p, url);
  }

  static rowFromParsed(label, product, p, purl) {
    const bits = [];
    if (p.storeName) bits.push(`store: ${p.storeName}`);
    if (p.qty != null) bits.push(`qty: ${p.qty}`);
    if (p.banner) bits.push(p.banner);
    return { label, product, purl, status: p.status, price: p.price, info: bits.join('; ') };
  }

  // Parallel sweep: N isolated sessions (own cookie jar, own tab in one
  // browser window), each working through a slice of the list with the proven
  // sequential flow (addCookies → in-page fetch → parse). Per-request cookie
  // rewriting via route interception does NOT work — Chromium's network layer
  // overrides the injected Cookie header with the jar's values.
  // Misses / transient failures are retried afterwards on the primary session.
  async sweepFetchParallel(items, concurrency, results) {
    const K = concurrency;
    // worker 0 is the primary session — run() already warmed it on urls[0],
    // so a single-session run never opens a second tab
    const workers = [{ ctx: this.ctx, page: this.page, k: 0, primary: true }];
    for (let k = 1; k < K; k++) {
      const ctx = await this.newSession();
      const page = await ctx.newPage();
      workers.push({ ctx, page, k });
    }
    for (const w of workers) {
      if (w.primary) continue;
      this.emit('log', `warming session ${w.k + 1}/${K}…`);
      await this.gotoWithRetry(this.productUrl, w.page);
    }

    const misses = []; // {item, url} pairs
    const checkOne = async (w, item) => {
      // respect the shared cooldown if another worker just hit a 429
      // (small per-worker jitter so sessions don't resume in lockstep)
      const waitMs = this.throttle.until - Date.now() + w.k * 700;
      if (waitMs > 0) await w.page.waitForTimeout(waitMs);

      // one cookie set per store, then every product is checked against it
      await w.ctx.addCookies([
        { name: 'latitude', value: String(item.lat), domain: '.zepto.com', path: '/' },
        { name: 'longitude', value: String(item.lng), domain: '.zepto.com', path: '/' },
        { name: 'user_position', value: JSON.stringify({ latitude: item.lat, longitude: item.lng }), domain: '.zepto.com', path: '/' },
      ]);
      await w.ctx.clearCookies({ name: 'serviceability' });

      for (const url of this.productUrls) {
        if (this.stopped) return;
        const rep = await w.page.evaluate(async u => {
          try {
            const r = await fetch(u, { credentials: 'include' });
            return { ok: r.ok, status: r.status, html: r.ok ? await r.text() : '' };
          } catch (e) {
            return { ok: false, status: 0, error: String(e).slice(0, 60) };
          }
        }, url);
        if (rep.status === 429) {
          this.throttle.fails++;
          const backoff = Math.min(60000, 5000 * this.throttle.fails);
          this.throttle.until = Date.now() + backoff;
          this.emit('log', `rate-limited (429), all sessions cooling down ${backoff / 1000}s…`);
          misses.push({ item, url });
          continue;
        }
        if (!rep.ok) { misses.push({ item, url }); continue; }
        this.throttle.fails = Math.max(0, this.throttle.fails - 1); // decay on success
        const p = parseSsrProduct(rep.html, pvidOf(url));
        if (p.name && !this.productNames[url]) {
          this.productNames[url] = p.name;
          this.emit('product', { url, name: p.name });
        }
        if (!p.foundProduct && p.status !== 'NO_SERVICE') { misses.push({ item, url }); continue; }
        const row = ZeptoChecker.rowFromParsed(item.label, this.productLabel(url), p, url);
        results.push(row);
        this.emit('result', row);
        await w.page.waitForTimeout(300);
      }
    };

    let done = 0;
    await Promise.all(workers.map(async (w, k) => {
      for (let i = k; i < items.length && !this.stopped; i += K) {
        try {
          await checkOne(w, items[i]);
        } catch (e) {
          misses.push(items[i]);
        }
        done++;
        if (done % 25 === 0) this.emit('log', `${done}/${items.length} checked…`);
        await w.page.waitForTimeout(700);
      }
    }));

    for (const m of misses) {
      if (this.stopped) break;
      let row = null;
      for (let attempt = 1; attempt <= 3 && !row && !this.stopped; attempt++) {
        try {
          this.emit('log', `retrying ${m.item.label} × ${this.productLabel(m.url)} (${attempt}/3)…`);
          row = await this.checkStoreViaFetch(m.item, m.url);
        } catch (e) {
          const msg = (e.message || '').split('\n')[0].slice(0, 80);
          if (/http-429/.test(msg) && attempt < 3) {
            this.emit('log', 'still rate-limited, waiting 30s…');
            await this.page.waitForTimeout(30000);
            continue;
          }
          row = { label: m.item.label, product: this.productLabel(m.url), purl: m.url, status: 'ERROR', price: '', info: msg };
        }
      }
      if (row) {
        results.push(row);
        this.emit('result', row);
      }
      await this.page.waitForTimeout(800);
    }

    await Promise.all(workers.filter(w => !w.primary).map(w => w.ctx.close().catch(() => {})));
  }

  classify(text) {
    if (/Add to Cart/i.test(text)) return 'IN_STOCK';
    if (/we (?:are |'re )?not (?:at|in) your (?:location|area)|we don'?t deliver|not serviceable|coming soon to your|do not deliver/i.test(text)) return 'NO_SERVICE';
    if (/sold out|out of stock|currently unavailable|notify me/i.test(text)) return 'SOLD_OUT';
    return 'UNKNOWN';
  }

  // Store-level banner shown above the product ("Store is Closed",
  // "High Demand, Schedule Order", …) — useful context next to the stock status.
  extractBanner(text) {
    const m = text.match(/store is closed|high demand[^\n]*/i);
    return m ? m[0] : '';
  }

  extractPrice(text) {
    const m = text.match(/₹\s*\n?\s*([\d,]+)\s*\n[\s\S]{0,60}?MRP\s*\n?\s*₹?\s*([\d,]+)/);
    if (m) return `₹${m[1]} (MRP ₹${m[2]})`;
    const m2 = text.match(/₹\s*\n?\s*([\d,]+)/);
    return m2 ? `₹${m2[1]}` : '';
  }

  async productName() {
    // share-widget title carries the full name WITH variant
    // ("Apple iPhone 17 Pro | 256 GB | Cosmic Orange"); <title> is short
    try {
      const html = await this.page.content();
      const n = shareProductName(html, pvidOf(this.page.url())) || cleanProductName(await this.page.title());
      if (n) return n;
    } catch (e) { /* fall through */ }
    try {
      const ld = await this.page.$$eval('script[type="application/ld+json"]', els =>
        els.map(e => { try { return JSON.parse(e.textContent); } catch { return null; } })
      ).catch(() => []);
      const prod = ld.flat().find(o => o && o['@type'] === 'Product');
      if (prod && prod.name) return prod.name;
    } catch (e) { /* fall through */ }
    return this.page.title();
  }

  async run(urls, items, opts = {}) {
    if (!Array.isArray(urls)) urls = [urls];
    this.productUrls = urls;
    this.productUrl = urls[0]; // page the SSR fetches are issued from
    this.productNames = {};
    const results = [];
    try {
      await this.launch();
      this.emit('log', 'loading product page…');
      await this.gotoWithRetry(urls[0]);
      const name0 = await this.productName();
      this.productNames[urls[0]] = name0;
      this.emit('product', { url: urls[0], name: name0 });

      const allCoords = items.length > 0 && items.every(i => i.lat != null && i.lng != null);
      if (allCoords) {
        const c = Math.min(8, Math.max(1, parseInt(opts.concurrency, 10) || 4));
        this.emit('log', `sweep of ${items.length} stores × ${urls.length} product(s) across ${c} session(s)…`);
        await this.sweepFetchParallel(items, c, results);
      } else {
        await this.sweepSequential(items, results);
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

  productLabel(url) {
    if (this.productNames && this.productNames[url]) return this.productNames[url];
    const m = (url || '').match(/\/pn\/([^/]+)/);
    return m ? m[1].replace(/-/g, ' ').slice(0, 40) : (url || '').slice(-20);
  }

  async sweepSequential(items, results) {
      for (const item of items) {
        if (this.stopped) break;
        try {
          if (item.lat != null && item.lng != null) {
            for (const purl of this.productUrls) {
              if (this.stopped) break;
              const row = await this.checkStoreViaFetch(item, purl);
              results.push(row);
              this.emit('result', row);
              await this.page.waitForTimeout(400);
            }
            await this.page.waitForTimeout(600);
            continue;
          }
          const r = await this.setLocation(item.queries || [item.query]);
          if (r.status !== 'SET') {
            const mapped = r.status === 'NO_SUGGESTION' ? 'NO_SERVICE' : r.status;
            for (const purl of this.productUrls) {
              const row = { label: item.label, product: this.productLabel(purl), purl, status: mapped, price: '', info: r.info || '' };
              results.push(row);
              this.emit('result', row);
            }
          } else {
            // location is set once; check every product against it
            for (let pi = 0; pi < this.productUrls.length; pi++) {
              if (this.stopped) break;
              const purl = this.productUrls[pi];
              if (pi > 0) await this.gotoWithRetry(purl);
              const text = await this.page.evaluate(() => document.body ? document.body.innerText.replace(/\n{2,}/g, '\n').trim() : '');
              const status = this.classify(text);
              const bits = [];
              if (r.via) bits.push(`via: ${r.via}`);
              const banner = this.extractBanner(text);
              if (banner) bits.push(banner);
              const row = { label: item.label, product: this.productLabel(purl), purl, status, price: status === 'IN_STOCK' ? this.extractPrice(text) : '', info: bits.join('; ') };
              results.push(row);
              this.emit('result', row);
              await this.page.waitForTimeout(600);
            }
          }
        } catch (e) {
          const row = { label: item.label, status: 'ERROR', price: '', info: (e.message || '').split('\n')[0].slice(0, 80) };
          results.push(row);
          this.emit('result', row);
          await this.page.waitForTimeout(2000);
        }
        await this.page.waitForTimeout(1000);
      }
  }
}

module.exports = { ZeptoChecker };
