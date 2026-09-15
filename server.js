const http = require('http');
const fs = require('fs');
const path = require('path');
const { ZeptoChecker } = require('./engine');

const PORT = 3456;
const PUBLIC = path.join(__dirname, 'public');

const state = {
  running: false,
  product: null,
  url: null,
  results: [],
  startedAt: null,
  error: null,
  stopped: false,
};
let checker = null;
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function snapshot() {
  return {
    running: state.running,
    product: state.product,
    url: state.url,
    results: state.results,
    startedAt: state.startedAt,
    error: state.error,
    stopped: state.stopped,
  };
}

function parsePins(body) {
  let from = String(body.from || '560001').trim();
  let to = String(body.to || '560110').trim();
  if (!/^\d{6}$/.test(from) || !/^\d{6}$/.test(to)) throw new Error('Pin codes must be 6 digits');
  if (to < from) [from, to] = [to, from];
  const a = parseInt(from, 10), b = parseInt(to, 10);
  if (b - a > 300) throw new Error('Range too large (max 300 pin codes)');
  const pins = [];
  for (let i = a; i <= b; i++) pins.push(String(i));
  return pins;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(PUBLIC, 'index.html')).pipe(res);
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
    const rows = ['pincode,status,price,info',
      ...state.results.map(r => `${r.pin},${r.status},"${r.price}","${r.info.replace(/"/g, "'")}"`)];
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
        const { url, from, to } = JSON.parse(body || '{}');
        if (!/^https:\/\/(www\.)?zepto\.com\/pn\//.test(url || '')) {
          throw new Error('URL must be a Zepto product page (https://www.zepto.com/pn/...)');
        }
        const pins = parsePins({ from, to });
        state.running = true;
        state.product = null;
        state.url = url;
        state.results = [];
        state.startedAt = new Date().toISOString();
        state.error = null;
        state.stopped = false;
        broadcast('snapshot', snapshot());

        checker = new ZeptoChecker();
        checker.on('product', p => { state.product = p; broadcast('product', p); });
        checker.on('result', r => { state.results.push(r); broadcast('result', r); });
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
        checker.run(url, pins).catch(() => { state.running = false; });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pins: pins.length }));
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
