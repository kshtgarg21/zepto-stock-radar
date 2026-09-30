const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ZeptoChecker } = require('./engine');

const PORT = 3456;
const PUBLIC = path.join(__dirname, 'public');

const state = {
  running: false,
  paused: false,
  pauseReason: '',
  sessionId: null,
  products: [],
  urls: [],
  mode: null,
  concurrency: 1,
  url: null,
  results: [],
  startedAt: null,
  error: null,
  stopped: false,
};

// --- session persistence: results survive restarts and can be resumed later ---
const SESSION_FILE = path.join(__dirname, 'data', 'run-state.json');
const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
let saveTimer = null;
function sessionPayload() {
  return {
    sessionId: state.sessionId,
    savedAt: new Date().toISOString(),
    urls: state.urls,
    products: state.products,
    mode: state.mode,
    concurrency: state.concurrency,
    startedAt: state.startedAt,
    items: state.items || [],
    results: state.results,
  };
}
function saveSession(immediate = false) {
  const write = () => {
    saveTimer = null;
    try {
      const payload = JSON.stringify(sessionPayload());
      fs.writeFileSync(SESSION_FILE, payload); // current session
      if (state.sessionId) fs.writeFileSync(path.join(SESSIONS_DIR, state.sessionId + '.json'), payload); // archive
    } catch (e) { /* best effort */ }
  };
  if (immediate) { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; write(); }
  else if (!saveTimer) saveTimer = setTimeout(write, 3000);
}
try {
  const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  state.sessionId = s.sessionId || null;
  state.urls = s.urls || [];
  state.products = s.products || [];
  state.mode = s.mode || null;
  state.concurrency = s.concurrency || 1;
  state.startedAt = s.startedAt || null;
  state.results = s.results || [];
  state.items = s.items || [];
  if (state.results.length) console.log(`restored session: ${state.results.length} rows, ${state.urls.length} product(s)`);
} catch (e) { /* no saved session yet */ }
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
  if (event === 'log' && data && data.message) {
    const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
    data = { ...data, message: `${ts}  ${data.message}` };
    logRing.push(data.message);
    if (logRing.length > 200) logRing.shift();
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}
const logRing = []; // recent engine log lines, replayed in snapshots
logRing.push(`${new Date().toLocaleTimeString('en-IN', { hour12: false })}  server ready`);

function snapshot() {
  return {
    running: state.running,
    paused: state.paused,
    pauseReason: state.pauseReason,
    sessionId: state.sessionId,
    resumable: !state.running && (state.urls || []).length > 0,
    totalQueries: (state.items || []).length * (state.urls || []).length,
    mode: state.mode,
    concurrency: state.concurrency,
    items: (state.items || []).map(i => i.label), // full labels — picker restore
    logTail: logRing.slice(-80),
    products: state.products,
    url: state.url,
    results: state.results,
    startedAt: state.startedAt,
    error: state.error,
    stopped: state.stopped,
  };
}

function launchRun(urlList, items, { concurrency = 1, merge = false, mode = null } = {}) {
  state.running = true;
  // a merge/resume run continues the same session; a fresh start opens a new one
  if (!merge || !state.sessionId) state.sessionId = 'S' + Date.now();
  state.urls = urlList;
  state.mode = mode || state.mode;
  state.concurrency = concurrency;
  // on merge/resume runs, keep the FULL stored item list — `items` here is
  // only the pending subset, and a later resume must see every store
  if (!merge || !(state.items || []).length) state.items = items;
  if (!merge) state.products = urlList.map(u => ({ url: u, name: null }));
  state.url = urlList[0];
  state.results = merge ? state.results : [];
  state.startedAt = state.startedAt && merge ? state.startedAt : new Date().toISOString();
  state.error = null;
  state.stopped = false;
  state.paused = false;
  state.pauseReason = '';
  broadcast('log', { message: `run started — ${items.length} store(s) × ${urlList.length} product(s) = ${items.length * urlList.length} checks` });
  broadcast('snapshot', snapshot());

  checker = new ZeptoChecker();
  checker.on('product', p => {
    const e = (state.products || []).find(x => x.url === p.url);
    if (e) e.name = p.name;
    broadcast('product', p);
  });
  checker.on('throttle', t => broadcast('throttle', t));
  checker.on('paused', p => { state.paused = true; state.pauseReason = p.reason; broadcast('paused', p); saveSession(true); });
  checker.on('resumed', () => { state.paused = false; broadcast('resumed', {}); });
  checker.on('result', r => {
    if (merge) {
      const i = state.results.findIndex(x => x.label === r.label && x.product === r.product);
      if (i >= 0) state.results[i] = r; else state.results.push(r);
    } else {
      state.results.push(r);
    }
    broadcast('result', r);
    saveSession(); // debounced
  });
  checker.on('log', l => broadcast('log', { message: l }));
  checker.on('done', d => {
    state.running = false;
    state.paused = false;
    state.stopped = d.stopped;
    broadcast('done', { total: d.results.length, stopped: d.stopped });
    saveSession(true);
  });
  checker.on('error', m => {
    state.running = false;
    state.paused = false;
    state.error = m;
    broadcast('error', { message: m });
    saveSession(true);
  });
  checker.run(urlList, items, { concurrency }).catch(() => { state.running = false; saveSession(true); });
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

  // a permanent URL per session: /session/<id> shows that archived sweep
  if (req.method === 'GET' && u.pathname.startsWith('/session/')) {
    const id = decodeURIComponent(u.pathname.slice('/session/'.length));
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(PUBLIC, 'sessions.html')).pipe(res);
    return;
  }

  if (req.method === 'GET' && u.pathname === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(PUBLIC, 'sessions.html')).pipe(res);
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
    res.on('error', () => sseClients.delete(res));
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
        launchRun(urlList, items, { concurrency, merge, mode });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: items.length * urlList.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/open') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { label, purl, sessionId } = JSON.parse(body || '{}');
        // resolve the store from the current session, or any archived one
        let items = state.items || [];
        if (sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId)) {
          try { items = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, sessionId + '.json'), 'utf8')).items || []; } catch (e) { items = []; }
        }
        const item = items.find(i => i.label === label);
        if (!item || item.lat == null) throw new Error('Store not found in this session');
        if (!/^https:\/\/(www\.)?zepto\.com\/pn\//.test(purl || '')) throw new Error('Invalid product URL');
        // detached one-off browser: product page open at that store's location,
        // window stays open for the user to browse/order
        const child = spawn(process.execPath, [
          path.join(__dirname, 'scripts', 'open-store-page.js'),
          purl, String(item.lat), String(item.lng),
          String(item.name || 'Store'), String(item.city || ''),
        ], { detached: true, stdio: 'ignore' });
        child.unref();
        broadcast('log', { message: `opening ${item.label} — product page in a new browser (location preset)` });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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

  if (req.method === 'GET' && u.pathname === '/api/sessions') {
    const list = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        const counts = {};
        (j.results || []).forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
        return {
          id: j.sessionId,
          savedAt: j.savedAt,
          startedAt: j.startedAt,
          rows: (j.results || []).length,
          products: (j.products || []).map(p => p.name || p.url),
          counts,
        };
      } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/sessions/load') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        if (state.running) throw new Error('A check is already running');
        const { id } = JSON.parse(body || '{}');
        if (!/^[A-Za-z0-9_-]+$/.test(id || '')) throw new Error('Invalid session id');
        const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id + '.json'), 'utf8'));
        state.sessionId = j.sessionId || id;
        state.urls = j.urls || [];
        state.products = j.products || [];
        state.mode = j.mode || null;
        state.concurrency = j.concurrency || 1;
        state.items = j.items || [];
        state.results = j.results || [];
        state.startedAt = j.startedAt || null;
        state.running = false;
        state.paused = false;
        state.error = null;
        saveSession(true);
        broadcast('snapshot', snapshot());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rows: state.results.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/api/sessions/') && u.pathname !== '/api/sessions') {
    const id = decodeURIComponent(u.pathname.slice('/api/sessions/'.length));
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid session id' }));
      return;
    }
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id + '.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(j));
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/sessions/delete') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body || '{}');
        if (!/^[A-Za-z0-9_-]+$/.test(id || '')) throw new Error('Invalid session id');
        fs.unlinkSync(path.join(SESSIONS_DIR, id + '.json'));
        if (state.sessionId === id) state.sessionId = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/resume') {
    try {
      // (a) live run paused on browser death: release it
      if (state.running && state.paused && checker) {
        // drop ERROR rows — the supervisor re-queues them with the pending stores
        state.results = state.results.filter(r => r.status !== 'ERROR');
        checker.resume();
        broadcast('snapshot', snapshot());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // (b) resume a saved session any time later: re-check every store that
      // isn't fully clean, after clearing old ERROR rows
      if (state.running) throw new Error('A check is already running');
      if (!state.urls.length) throw new Error('No saved session to resume');
      state.results = state.results.filter(r => r.status !== 'ERROR'); // cleared
      const urlSet = new Set(state.urls);
      const cleanPerStore = {};
      state.results.forEach(r => {
        if (urlSet.has(r.purl)) cleanPerStore[r.label] = (cleanPerStore[r.label] || 0) + 1;
      });
      const sessionItems = (state.items || []).length ? state.items
        : (() => { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).items || []; } catch { return []; } })();
      const pending = sessionItems.filter(it => (cleanPerStore[it.label] || 0) < state.urls.length);
      if (!pending.length) throw new Error('Session already complete — start a new check instead');
      launchRun(state.urls, pending, { concurrency: state.concurrency, merge: true, mode: state.mode });
      broadcast('snapshot', snapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: pending.length * state.urls.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is another instance running?`);
    process.exit(1);
  }
  throw e;
});

// heartbeat: lets the dashboard detect a half-open SSE connection
setInterval(() => broadcast('ping', { t: Date.now() }), 15000);

server.listen(PORT, () => {
  console.log(`Zepto Stock Checker running at http://localhost:${PORT}`);
});
