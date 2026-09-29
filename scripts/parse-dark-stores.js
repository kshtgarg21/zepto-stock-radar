// Parse a dark store list into data/zepto-dark-stores.json.
// Input: id, name, lat, lng, city, state — comma OR tab separated, header row
// required. Usage: node scripts/parse-dark-stores.js [input-file]
// (default: data/dark-stores.tsv)
const fs = require('fs');
const path = require('path');

const input = process.argv[2] || path.join(__dirname, '..', 'data', 'dark-stores.tsv');
const src = fs.readFileSync(input, 'utf8');
const lines = src.split('\n').map(l => l.trim()).filter(Boolean);

const stores = [];
const skipped = [];

for (const line of lines.slice(1)) { // skip header
  // tab separated, comma separated, or runs of 2+ spaces
  let f = line.split('\t').map(s => s.trim());
  if (f.length < 6) f = line.split(',').map(s => s.trim());
  if (f.length < 6) f = line.split(/\s{2,}/).map(s => s.trim());
  if (f.length < 6) { skipped.push(line); continue; }
  const [id, name, lat, lng, city, ...rest] = f;
  const state = rest.join(' ');
  const la = parseFloat(lat), ln = parseFloat(lng);
  if (!name || !isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
    skipped.push(line);
    continue;
  }
  if (/^test\b/i.test(name) || /^test city$/i.test(city)) { // Zepto internal test stores
    skipped.push(line);
    continue;
  }
  stores.push({ id, name, lat: la, lng: ln, city, state });
}

const seen = new Set();
const unique = stores.filter(s => {
  const k = s.id || `${s.name}|${s.lat}|${s.lng}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

fs.writeFileSync(
  path.join(__dirname, '..', 'data', 'zepto-dark-stores.json'),
  JSON.stringify(unique, null, 2)
);

const cities = [...new Set(unique.map(s => s.city))].sort();
console.log(`input: ${input}`);
console.log(`parsed: ${stores.length}, unique: ${unique.length}, skipped: ${skipped.length}`);
console.log(`cities (${cities.length}): ${cities.join(', ')}`);
skipped.slice(0, 10).forEach(s => console.log('SKIPPED:', s));
