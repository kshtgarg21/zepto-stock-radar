const { chromium } = require('playwright');
const { EventEmitter } = require('events');
const { parseSsrProduct, cleanProductName, shareProductName } = require('./ssr-parse');

const pvidOf = u => ((u || '').match(/pvid\/([0-9a-f-]+)/) || [])[1];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PER_CALL_DELAY_MS = 1400; // pause after every fetch — keeps us under the WAF rate limit

// bound a protocol call: a wedged browser hangs addCookies/evaluate forever —
// this turns the hang into a rejection so the caller aborts CLEANLY (no
// abandoned checkOne mutating cookies in the background)
const bounded = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(what + `-timeout-${Math.round(ms / 1000)}s`)), ms)),
]);

class ZeptoChecker extends EventEmitter {
  constructor() {
    super();
    this.stopped = false;
    this.browser = null;
    this.throttle = { until: 0, fails: 0 }; // shared 429 cooldown across workers
    this.paused = false;                    // paused waiting for user Resume
    this.resumeResolve = null;
  }

  stop() {
    this.stopped = true;
    this.resume(); // release a pending pause-wait so the run can wind down
    if (this.browser) this.browser.close().catch(() => {});
  }

  // Pause/resume: on browser death the run pauses; the browser is only
  // recreated and the sweep continued when the user calls resume().
  waitResume() {
    return new Promise(resolve => { this.resumeResolve = resolve; });
  }

  resume() {
    if (!this.resumeResolve) return;
    this.paused = false;
    this.emit('resumed', {});
    const r = this.resumeResolve;
    this.resumeResolve = null;
    r();
  }

  // 429 backoff ladder: 40s, 45s, 50s … capped at 60s. Emits a 'throttle'
  // event so the UI can show a live cooldown banner, and clears it
  // automatically when the cooldown window expires.
  backoff429() {
    this.throttle.fails++;
    const ms = Math.min(60000, 40000 + (this.throttle.fails - 1) * 5000);
    this.throttle.until = Date.now() + ms;
    this.throttle.gen = (this.throttle.gen || 0) + 1;
    const gen = this.throttle.gen;
    this.emit('throttle', { active: true, cooldownMs: ms, fails: this.throttle.fails });
    setTimeout(() => {
      if (this.throttle.gen === gen) this.emit('throttle', { active: false }); // newer strike supersedes
    }, ms + 500);
    return ms;
  }

  throttleClear() {
    this.throttle.fails = Math.max(0, this.throttle.fails - 1);
    if (this.throttle.fails === 0) this.emit('throttle', { active: false });
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
      await page.waitForTimeout(4000 + a * 3000);
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
      await bounded(this.page.evaluate(({ lat, lng, name, city }) => {
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
      }, { lat, lng, name, city }), 45000, 'evaluate');
      await bounded(this.ctx.addCookies([
        { name: 'latitude', value: String(lat), domain: '.zepto.com', path: '/' },
        { name: 'longitude', value: String(lng), domain: '.zepto.com', path: '/' },
        { name: 'user_position', value: JSON.stringify({ latitude: lat, longitude: lng }), domain: '.zepto.com', path: '/' },
      ]), 60000, 'addCookies');
      await bounded(this.ctx.clearCookies({ name: 'serviceability' }), 60000, 'clearCookies'); // stale store resolution would confuse SSR
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
    const waitMs = this.throttle.until - Date.now(); // respect the shared 429 cooldown
    if (waitMs > 0) await this.page.waitForTimeout(waitMs);
    await bounded(this.ctx.addCookies([
      { name: 'latitude', value: String(lat), domain: '.zepto.com', path: '/' },
      { name: 'longitude', value: String(lng), domain: '.zepto.com', path: '/' },
      { name: 'user_position', value: JSON.stringify({ latitude: lat, longitude: lng }), domain: '.zepto.com', path: '/' },
    ]), 60000, 'addCookies');
    await bounded(this.ctx.clearCookies({ name: 'serviceability' }), 60000, 'clearCookies');
    const html = await Promise.race([
      this.page.evaluate(async u => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
          const r = await fetch(u, { credentials: 'include', signal: ctrl.signal });
          clearTimeout(timer);
          if (!r.ok) throw new Error(`http-${r.status}`);
          return await r.text();
        } catch (e) {
          throw new Error(e && e.name === 'AbortError' ? 'timeout-30s' : e.message);
        }
      }, url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate-timeout-45s')), 45000)),
    ]);
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
      const text = await bounded(this.page.evaluate(() => document.body ? document.body.innerText.replace(/\n{2,}/g, '\n').trim() : ''), 45000, 'evaluate');
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
    const fetchVia = (page, url) => Promise.race([
      page.evaluate(async u => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30000);
          const r = await fetch(u, { credentials: 'include', signal: ctrl.signal });
          clearTimeout(timer);
          return { ok: r.ok, status: r.status, html: r.ok ? await r.text() : '' };
        } catch (e) {
          const msg = e && e.name === 'AbortError' ? 'timeout-30s' : String(e);
          return { ok: false, status: 0, error: msg.slice(0, 60) };
        }
      }, url),
      new Promise(res => setTimeout(() => res({ ok: false, status: 0, error: 'evaluate-timeout-45s' }), 45000)),
    ]);

    const checkOne = async (w, item) => {
      // one cookie set per store, then every product is checked against it
      await bounded(w.ctx.addCookies([
        { name: 'latitude', value: String(item.lat), domain: '.zepto.com', path: '/' },
        { name: 'longitude', value: String(item.lng), domain: '.zepto.com', path: '/' },
        { name: 'user_position', value: JSON.stringify({ latitude: item.lat, longitude: item.lng }), domain: '.zepto.com', path: '/' },
      ]), 60000, 'addCookies');
      await bounded(w.ctx.clearCookies({ name: 'serviceability' }), 60000, 'clearCookies');

      for (const url of this.productUrls) {
        if (this.stopped) return;
        // throttle gate before EVERY fetch: after a 429 the remaining products
        // wait out the cooldown, then continue at the normal per-call delay
        const gateMs = this.throttle.until - Date.now() + w.k * 200;
        if (gateMs > 0) {
          this.emit('log', `cooldown ${Math.round(gateMs / 1000)}s… (${misses.length} queued for retry)`);
          await w.page.waitForTimeout(gateMs);
        }

        let rep = await fetchVia(w.page, url);
        this.emit('log', `⌁ ${rep.status || rep.error || '?'} · ${item.label.split(' (')[0]} × ${this.productLabel(url).slice(0, 26)}`);
        if (rep.status === 429) {
          // retry THIS product once after the cooldown (not the whole batch)
          const backoff = this.backoff429();
          this.emit('log', `429 — cooling ${Math.round(backoff / 1000)}s, then retrying this product…`);
          await w.page.waitForTimeout(backoff + 500);
          rep = await fetchVia(w.page, url);
          this.emit('log', `⌁ retry ${rep.status || rep.error || '?'} · ${item.label.split(' (')[0]}`);
        }
        // a 202 here is the WAF challenge page: the session's token went
        // stale. Per spec — just close and restart the browser; the
        // supervisor relaunches and the pending filter re-runs this store.
        // (connection failures are NOT restarts — they're waited out below)
        if (rep.status === 202) {
          this.emit('log', '202 WAF challenge — restarting the browser for a fresh session…');
          throw new Error('restart-browser-202');
        }
        const good = rep.ok;
        if (!good) {
          // still blocked after the inline retry — re-arm the shared cooldown so
          // the next product waits instead of firing into the void
          this.backoff429();
          misses.push({ item, url });
          await w.page.waitForTimeout(PER_CALL_DELAY_MS);
          continue;
        }
        this.throttleClear();
        this.restarts202 = 0; // progress made — the restart budget resets
        const p = parseSsrProduct(rep.html, pvidOf(url));
        if (p.name && !this.productNames[url]) {
          this.productNames[url] = p.name;
          this.emit('product', { url, name: p.name });
        }
        if (!p.foundProduct && p.status !== 'NO_SERVICE') { misses.push({ item, url }); await w.page.waitForTimeout(PER_CALL_DELAY_MS); continue; }
        const row = ZeptoChecker.rowFromParsed(item.label, this.productLabel(url), p, url);
        results.push(row);
        this.emit('result', row);
        await w.page.waitForTimeout(PER_CALL_DELAY_MS);
      }
    };

    let done = 0;
    await Promise.all(workers.map(async (w, k) => {
      let consecutiveFailures = 0;
      for (let i = k; i < items.length && !this.stopped; i += K) {
        try {
          await checkOne(w, items[i]);
          consecutiveFailures = 0;
        } catch (e) {
          const msg = (e.message || '').split('\n')[0].slice(0, 80);
          consecutiveFailures++;
          this.emit('log', `store failed (${msg}) — ${consecutiveFailures} consecutive`);
          // 3 in a row means the browser/session is broken, not the store —
          // hand control to the supervisor (pause or 202-restart)
          if (consecutiveFailures >= 3 || /restart-browser-202|Target|closed|unresponsive/i.test(msg)) {
            throw e;
          }
          // transient store failure — queue for the sequential retry pass
          for (const u of this.productUrls) misses.push({ item: items[i], url: u });
        }
        done++;
        if (done % 25 === 0) this.emit('log', `${done}/${items.length} checked…`);
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
          if (/Target|closed|browser has been|store-watchdog|unresponsive/i.test(msg)) {
            throw e; // browser died or is wedged — let the supervisor pause/resume
          }
          if (/http-429/.test(msg) && attempt < 3) {
            const wait = Math.max(5000, this.throttle.until - Date.now());
            this.emit('log', `still rate-limited, waiting ${Math.round(wait / 1000)}s…`);
            await this.page.waitForTimeout(wait);
            continue;
          }
          row = { label: m.item.label, product: this.productLabel(m.url), purl: m.url, status: 'ERROR', price: '', info: msg };
        }
      }
      if (row) {
        results.push(row);
        this.emit('result', row);
      }
      await this.page.waitForTimeout(PER_CALL_DELAY_MS);
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
    const MAX_ATTEMPTS = 5;
    // supervisor: if the browser dies (closed window, crash) or the WAF hiccups,
    // relaunch and resume from the stores that don't have clean rows yet
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !this.stopped; attempt++) {
      try {
        await this.launch();
        this.emit('log', attempt > 1 ? `resuming (attempt ${attempt}/${MAX_ATTEMPTS})…` : 'loading product page…');
        await this.gotoWithRetry(urls[0]);
        if (!this.productNames[urls[0]]) {
          const name0 = await this.productName();
          this.productNames[urls[0]] = name0;
          this.emit('product', { url: urls[0], name: name0 });
        }
        const urlSet = new Set(urls);
        const pending = items.filter(it =>
          results.filter(r => r.label === it.label && r.status !== 'ERROR' && urlSet.has(r.purl)).length < urls.length);
        if (!pending.length) break;
        if (attempt > 1) this.emit('log', `resuming: ${pending.length}/${items.length} stores left`);
        const allCoords = pending.every(i => i.lat != null && i.lng != null);
        if (allCoords) {
          const c = Math.min(8, Math.max(1, parseInt(opts.concurrency, 10) || 4));
          await this.sweepFetchParallel(pending, c, results);
        } else {
          await this.sweepSequential(pending, results);
        }
        break; // clean finish
      } catch (e) {
        if (this.stopped) break;
        const msg = e.message || String(e);
        // 202 WAF challenge: close and restart the browser automatically —
        // this doesn't consume a pause/resume attempt (capped at 20 restarts)
        if (/restart-browser-202/.test(msg)) {
          this.restarts202 = (this.restarts202 || 0) + 1;
          if (this.restarts202 > 20) {
            this.emit('log', 'WAF kept challenging after 20 browser restarts — pausing. Press Resume to retry.');
            this.paused = true;
            this.emit('paused', { reason: 'WAF kept challenging after 20 browser restarts', attempt, maxAttempts: MAX_ATTEMPTS });
            await this.waitResume();
            if (this.stopped) break;
            this.restarts202 = 0;
            continue;
          }
          this.emit('log', `restarting the browser for a fresh session (restart ${this.restarts202}/20)…`);
          await new Promise(r => setTimeout(r, 2000));
          attempt--; // restarts don't count against MAX_ATTEMPTS
          continue;
        }
        if (attempt === MAX_ATTEMPTS) { this.emit('error', msg); break; }
        // anything else (browser closed, wedged, unknown) — pause and wait
        // for the user to press Resume (browser is recreated then)
        this.paused = true;
        this.emit('paused', { reason: msg.split('\n')[0].slice(0, 100), attempt, maxAttempts: MAX_ATTEMPTS });
        await this.waitResume();
        if (this.stopped) break;
      } finally {
        if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
      }
    }
    this.emit('done', { results, stopped: this.stopped });
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
              await this.page.waitForTimeout(PER_CALL_DELAY_MS);
            }
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
              const text = await bounded(this.page.evaluate(() => document.body ? document.body.innerText.replace(/\n{2,}/g, '\n').trim() : ''), 45000, 'evaluate');
              const status = this.classify(text);
              const bits = [];
              if (r.via) bits.push(`via: ${r.via}`);
              const banner = this.extractBanner(text);
              if (banner) bits.push(banner);
              const row = { label: item.label, product: this.productLabel(purl), purl, status, price: status === 'IN_STOCK' ? this.extractPrice(text) : '', info: bits.join('; ') };
              results.push(row);
              this.emit('result', row);
              await this.page.waitForTimeout(PER_CALL_DELAY_MS);
            }
          }
        } catch (e) {
          const row = { label: item.label, product: this.productUrls.length ? this.productLabel(this.productUrls[0]) : '', purl: this.productUrls[0], status: 'ERROR', price: '', info: (e.message || '').split('\n')[0].slice(0, 80) };
          results.push(row);
          this.emit('result', row);
          await this.page.waitForTimeout(2000);
        }
        await this.page.waitForTimeout(1000);
      }
  }
}

module.exports = { ZeptoChecker };
