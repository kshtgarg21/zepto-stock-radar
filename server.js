const http = require('http');
const fs = require('fs');
const path = require('path');
const { ZeptoChecker } = require('./engine');

const PORT = 3456;
const PUBLIC = path.join(__dirname, 'public');

const state = {
  running: false,
  products: [],
  url: null,
  results: [],
  startedAt: null,
  error: null,
  stopped: false,
};
let checker = null;
const sseClients = new Set();

// --- geocoding (Nominatim / OpenStreetMap, cached) ---
const GEO_CACHE = path.join(__dirname, 'data', 'geocode-cache.json');
let geocodeCache = {};
try { geocodeCache = JSON.parse(fs.readFileSync(GEO_CACHE, 'utf8')); } catch (e) { /* empty */ }
let geocoding = false;

async function geocodeAll() {
  if (geocoding) return;
  geocoding = true;
  try {
    const stores = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'zepto-stores.json'), 'utf8'));
    for (let i = 0; i < stores.length; i++) {
      if (geocodeCache[i]) continue;
      const s = stores[i];
      const q = encodeURIComponent(`${s.area}, Bangalore, Karnataka ${s.pin}`);
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`, {
          headers: { 'User-Agent': 'zepto-stock-checker/1.0 (personal hobby project)' },
        });
        const j = await r.json();
        if (Array.isArray(j) && j[0]) {
          geocodeCache[i] = { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
          fs.writeFileSync(GEO_CACHE, JSON.stringify(geocodeCache));
          broadcast('geocode', { index: i, lat: geocodeCache[i].lat, lng: geocodeCache[i].lng });
        }
      } catch (e) { /* skip failed lookup, continue */ }
      await new Promise(res => setTimeout(res, 1100));
    }
  } finally {
    geocoding = false;
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function snapshot() {
  return {
    running: state.running,
    products: state.products,
    url: state.url,
    results: state.results,
    startedAt: state.startedAt,
    error: state.error,
    stopped: state.stopped,
  };
}

function buildItems(body) {
  if (body.mode === 'darkstores-approx') {
    const stores = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'zepto-dark-stores-approx.json'), 'utf8'));
    let list = stores;
    if (Array.isArray(body.selected) && body.selected.length) {
      list = body.selected.map(i => stores[i]).filter(Boolean);
    }
    // ~approx: centroids of service areas, not exact store coordinates —
    // the result's "store:" field shows which store actually served the check
    let items = list.map(s => ({
      label: `${s.name} (${s.city}, ${s.state}) ~approx`,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      city: s.city,
    }));
    if (body.limit) items = items.slice(0, Math.max(1, parseInt(body.limit, 10) || 1));
    if (!items.length) throw new Error('No approximate store entries found');
    if (items.length > 1500) throw new Error('Too many locations (max 1500)');
    return items;
  }
  if (body.mode === 'darkstores') {
    const stores = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'zepto-dark-stores.json'), 'utf8'));
    let list = stores;
    if (Array.isArray(body.selected) && body.selected.length) {
      list = body.selected.map(i => stores[i]).filter(Boolean);
    }
    let items = list.map(s => ({
      label: `${s.name} (${s.city}, ${s.state})`,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      city: s.city,
    }));
    if (body.limit) items = items.slice(0, Math.max(1, parseInt(body.limit, 10) || 1));
    if (!items.length) throw new Error('No dark store entries found (run scripts/parse-dark-stores.js)');
    if (items.length > 1500) throw new Error('Too many locations (max 1500)'); // fast path ~1.3s/store
    return items;
  }
  if (body.mode === 'stores') {
    const stores = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'zepto-stores.json'), 'utf8'));
    let list = stores;
    if (Array.isArray(body.selected) && body.selected.length) {
      list = body.selected.map(i => stores[i]).filter(Boolean);
    }
    let items = list.map(s => ({
      label: `${s.name} (${s.area} ${s.pin})`,
      queries: [
        `${s.name}, ${s.area}, Bangalore, Karnataka ${s.pin}`,
        `${s.area}, Bangalore, Karnataka ${s.pin}`,
        s.pin,
      ],
    }));
    if (body.limit) items = items.slice(0, Math.max(1, parseInt(body.limit, 10) || 1));
    if (!items.length) throw new Error('No store entries found');
    if (items.length > 300) throw new Error('Too many locations (max 300)');
    return items;
  }
  let from = String(body.from || '560001').trim();
  let to = String(body.to || '560110').trim();
  if (!/^\d{6}$/.test(from) || !/^\d{6}$/.test(to)) throw new Error('Pin codes must be 6 digits');
  if (to < from) [from, to] = [to, from];
  const a = parseInt(from, 10), b = parseInt(to, 10);
  if (b - a > 300) throw new Error('Range too large (max 300 pin codes)');
  const items = [];
  for (let i = a; i <= b; i++) items.push({ label: String(i), queries: [String(i)] });
  return items;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(PUBLIC, 'index.html')).pipe(res);
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/stores') {
    const stores = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'zepto-stores.json'), 'utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stores));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/dark-stores') {
    let stores = [];
    try { stores = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'zepto-dark-stores.json'), 'utf8')); } catch (e) { /* no dataset yet */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stores));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/dark-stores-approx') {
    let stores = [];
    try { stores = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'zepto-dark-stores-approx.json'), 'utf8')); } catch (e) { /* no dataset yet */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stores));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/geocode') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(geocodeCache));
    geocodeAll(); // fills in missing coordinates in the background
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/csv') {
    const rows = ['location,product,status,price,info',
      ...state.results.map(r => `"${r.label.replace(/"/g, "'")}","${(r.product || '').replace(/"/g, "'")}",${r.status},"${r.price}","${r.info.replace(/"/g, "'")}"`)];
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="zepto-stock-results.csv"',
    });
    res.end(rows.join('\n'));
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/start') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        if (state.running) throw new Error('A check is already running');
        const { url, urls, mode, from, to, limit, selected, concurrency, merge } = JSON.parse(body || '{}');
        const urlList = (Array.isArray(urls) && urls.length ? urls : [url])
          .map(u => String(u || '').trim()).filter(Boolean);
        if (!urlList.length || urlList.some(u => !/^https:\/\/(www\.)?zepto\.com\/pn\//.test(u))) {
          throw new Error('URLs must be Zepto product pages (https://www.zepto.com/pn/...)');
        }
        if (urlList.length > 10) throw new Error('Too many products (max 10)');
        const items = buildItems({ mode, from, to, limit, selected });
        state.running = true;
        if (!merge) state.products = urlList.map(u => ({ url: u, name: null }));
        state.url = urlList[0];
        state.results = merge ? state.results : [];
        state.startedAt = new Date().toISOString();
        state.error = null;
        state.stopped = false;
        broadcast('snapshot', snapshot());

        checker = new ZeptoChecker();
        checker.on('product', p => {
          const e = (state.products || []).find(x => x.url === p.url);
          if (e) e.name = p.name;
          broadcast('product', p);
        });
        checker.on('result', r => {
          if (merge) {
            const i = state.results.findIndex(x => x.label === r.label && x.product === r.product);
            if (i >= 0) state.results[i] = r; else state.results.push(r);
          } else {
            state.results.push(r);
          }
          broadcast('result', r);
        });
        checker.on('log', l => broadcast('log', { message: l }));
        checker.on('done', d => {
          state.running = false;
          state.stopped = d.stopped;
          broadcast('done', { total: d.results.length, stopped: d.stopped });
        });
        checker.on('error', m => {
          state.running = false;
          state.error = m;
          broadcast('error', { message: m });
        });
        checker.run(urlList, items, { concurrency }).catch(() => { state.running = false; });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: items.length * urlList.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/stop') {
    if (checker) checker.stop();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Zepto Stock Checker running at http://localhost:${PORT}`);
});
