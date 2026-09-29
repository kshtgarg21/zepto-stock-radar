// Offline test of ssr-parse against saved SSR dumps (scripts/dump-ssr-samples.js).
const fs = require('fs');
const path = require('path');
const { parseSsrProduct } = require('../ssr-parse');

const cases = [
  {
    file: 'chennai.html',
    expect: { status: 'IN_STOCK', price: '₹599 (MRP ₹780)', qty: 12, storeName: 'CHN-Sholinganallur New', banner: 'High Demand, Schedule Order', name: 'Surf Excel Matic Liquid Detergent 5 kg for Top Load | Removes tough Stains in 1st wash' },
  },
  {
    file: 'surat.html',
    expect: { status: 'IN_STOCK', price: '₹599 (MRP ₹780)', qty: 1, storeName: 'SUR-Adajan', banner: 'Store is Closed', name: 'Surf Excel Matic Liquid Detergent 5 kg for Top Load | Removes tough Stains in 1st wash' },
  },
];

let fail = 0;
for (const c of cases) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'data', 'samples', c.file), 'utf8');
  const got = parseSsrProduct(html);
  const rows = Object.keys(c.expect).map(k => {
    const ok = got[k] === c.expect[k];
    if (!ok) fail++;
    return `  ${ok ? 'ok  ' : 'FAIL'} ${k}: got ${JSON.stringify(got[k])}` + (ok ? '' : ` expected ${JSON.stringify(c.expect[k])}`);
  });
  console.log(c.file);
  console.log(rows.join('\n'));
}
console.log(fail ? `\n${fail} assertion(s) FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
