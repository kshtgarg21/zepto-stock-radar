const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'stores.txt'), 'utf8');
const lines = src.split('\n').map(l => l.trim());

const AREA_RE = /^(.+), (?:Bangalore|Bengaluru), Karnataka - (\d{6})$/;
const stores = [];
let skipped = [];

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('Zepto · ')) continue;
  const name = lines[i].slice('Zepto · '.length).trim();
  const areaLine = lines[i + 1] || '';
  const m = areaLine.match(AREA_RE);
  if (!m) {
    skipped.push(`${name} -> "${areaLine}"`);
    continue;
  }
  stores.push({ name, area: m[1].trim(), pin: m[2] });
}

const seen = new Set();
const unique = stores.filter(s => {
  const k = `${s.name}|${s.area}|${s.pin}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

fs.writeFileSync(
  path.join(__dirname, '..', 'data', 'zepto-stores.json'),
  JSON.stringify(unique, null, 2)
);

console.log(`parsed: ${stores.length}, unique: ${unique.length}, skipped: ${skipped.length}`);
skipped.forEach(s => console.log('SKIPPED:', s));
const pins = [...new Set(unique.map(s => s.pin))];
console.log(`distinct pincodes: ${pins.length}`);
