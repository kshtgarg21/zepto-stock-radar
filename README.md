# zepto-stock-checker

Check a Zepto product's availability across store locations from a local dashboard.
Uses Playwright (headed Chromium — Zepto blocks headless browsers) to set the
delivery location and read per-store stock state.

## Quickstart

```bash
npm install --registry=https://registry.npmjs.org   # playwright is blocked on the corporate registry
npm start
# open http://localhost:3456
```

On the first `npm install`, Chromium (~95 MB) is downloaded to
`~/Library/Caches/ms-playwright` and shared across runs.

## Usage

1. Paste a Zepto product URL (`https://www.zepto.com/pn/...`).
2. Pick a store list:
   - **Dark stores, multi-city** — exact coordinates from `data/zepto-dark-stores.json`.
     ~1s per store: fetches the product page's SSR payload inside the browser
     session and parses structured data — price, MRP, **exact stock quantity**,
     the actual serving store, and its status banner (e.g. "Store is Closed").
   - **Bangalore stores** — address text search per store (~13s each), reads the
     rendered product page.
3. Start. A Chromium window opens and works through the list.
4. Watch live results (table or map), then download the CSV.

Statuses: `IN_STOCK`, `SOLD_OUT` (serviceable, no stock), `NO_SERVICE`
(location not serviceable / no address suggestion), `ERROR`.

## Dark store dataset

`data/dark-stores.tsv` holds dark stores as tab-separated rows with a header:

```
id	name	lat	lng	city	state
cd810e0e-…	CHN-Sholinganallur New	12.930555	80.232566	Chennai	Tamilnadu
```

The `id` is Zepto's internal store UUID — setting the location to a row's
`lat`/`lng` resolves server-side to exactly that store, and the parsed result's
`store: …` field shows the actual serving store (a different store means Zepto
fell back to a neighbour, e.g. when the primary is closed).

After editing the TSV:

```bash
node scripts/parse-dark-stores.js   # regenerates data/zepto-dark-stores.json
```

## Layout

- `server.js` — HTTP server: start/stop API, SSE live updates, CSV export
- `engine.js` — Playwright automation (`ZeptoChecker`): modal/address-search
  flow, coordinate location setting, fast SSR-fetch checks
- `ssr-parse.js` — parses the SSR flight payload (price, qty, serving store, banner)
- `public/index.html` — dashboard UI
- `scripts/parse-stores.js` — `data/stores.txt` → `data/zepto-stores.json` (Bangalore)
- `scripts/parse-dark-stores.js` — `data/dark-stores.tsv` → `data/zepto-dark-stores.json`
- `scripts/dump-ssr-samples.js` + `scripts/test-ssr-parse.js` — offline parser fixtures/test
- `scripts/probe-*.js` — one-off site investigations (how Zepto persists location, etc.)
