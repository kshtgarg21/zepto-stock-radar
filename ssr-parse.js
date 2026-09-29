// Parse Zepto's SSR product page (Next.js RSC flight payload + HTML) for
// per-store availability and pricing. The flight strings escape quotes (\")
// so we unescape once, then read plain JSON-ish keys.
//
// Anchors found in the payload (see scripts/probe-inpage-fetch.js):
//   "storeDetailedInfo":{"city":"Surat","name":"SUR-Adajan"}   actual serving store
//   "etaInformation":{"primaryText":"Store is Closed"}         store-level banner
//   "productInfo":{... "storeProduct":{ "mrp":78000,            main product block
//      "discountedSellingPrice":59900, "availableQuantity":12,
//      "outOfStock":false, ... } }

function parseSsrProduct(html) {
  const out = { foundProduct: false, status: 'UNKNOWN', price: '', qty: null, storeName: '', banner: '' };
  if (!html || html.length < 10000) return out; // WAF challenge pages are ~2KB

  const un = html.replace(/\\"/g, '"');

  const sm = un.match(/"storeDetailedInfo":\{"city":"[^"]*","name":"([^"]+)"/);
  if (sm) out.storeName = sm[1];

  const em = un.match(/"etaInformation":\{([^}]*)\}/);
  if (em) {
    const p = em[1].match(/"primaryText":"([^"]+)"/);
    const s = em[1].match(/"secondaryText":"([^"]+)"/);
    out.banner = ((p && p[1]) || (s && s[1]) || '').trim();
  }

  const pi = un.indexOf('"productInfo"');
  const scope = pi >= 0 ? un.slice(pi, pi + 30000) : un;
  const sp = scope.indexOf('"storeProduct"');
  if (sp < 0) {
    if (/"serviceable":false|not serviceable|we don'?t deliver|do not deliver/i.test(un)) out.status = 'NO_SERVICE';
    return out;
  }

  const win = scope.slice(sp, sp + 3000);
  const num = re => { const m = win.match(re); return m ? parseInt(m[1], 10) : null; };
  const mrp = num(/"mrp":(\d+)/);
  const dsp = num(/"discountedSellingPrice":(\d+)/);
  const qty = num(/"availableQuantity":(\d+)/);
  const oos = win.match(/"outOfStock":(true|false)/);
  const outOfStock = oos ? oos[1] === 'true' : null;
  const addToCart = /Add to Cart/i.test(html);

  out.foundProduct = true;
  out.qty = qty;
  if (dsp != null) {
    const rs = v => `₹${(v / 100).toLocaleString('en-IN')}`;
    out.price = mrp != null && mrp > dsp ? `${rs(dsp)} (MRP ${rs(mrp)})` : rs(dsp);
  }

  if (outOfStock === true || qty === 0) out.status = 'SOLD_OUT';
  else if (addToCart || (qty != null && qty > 0)) out.status = 'IN_STOCK';
  else if (/notify me|out of stock|sold out/i.test(un)) out.status = 'SOLD_OUT';

  return out;
}

module.exports = { parseSsrProduct };
