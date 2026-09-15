# zepto-stock-checker

Check a Zepto product's availability across pin codes from a local dashboard.
Uses Playwright (headed Chromium — Zepto blocks headless browsers) to enter each
pin code into the location picker and read the product page state.

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
2. Set the pin code range (default: Bengaluru, 560001–560110).
3. Start. A Chromium window opens and works through each pin code (~13s each).
4. Watch live results, then download the CSV.

Statuses: `IN_STOCK`, `SOLD_OUT` (serviceable, no stock), `NO_SERVICE`
(no address suggestion for that pin code), `ERROR`.

## Layout

- `server.js` — HTTP server: start/stop API, SSE live updates, CSV export
- `engine.js` — Playwright automation (`ZeptoChecker`)
- `public/index.html` — dashboard UI
