// Open a Zepto product page with the delivery location set to a dark store,
// in a visible browser that STAYS OPEN for manual browsing/ordering.
// Usage: node scripts/open-store-page.js <product-url> <lat> <lng> [name] [city]
const { ZeptoChecker } = require('../engine');

const [url, lat, lng, name = 'Location', city = ''] = process.argv.slice(2);
if (!url || !lat || !lng) {
  console.error('usage: node scripts/open-store-page.js <product-url> <lat> <lng> [name] [city]');
  process.exit(1);
}

(async () => {
  const checker = new ZeptoChecker();
  await checker.launch();
  await checker.gotoWithRetry(url);
  checker.productUrl = url;
  const r = await checker.setLocationByCoords({ lat: +lat, lng: +lng, name, city });
  console.log('location set:', JSON.stringify(r));
  console.log('browser left open — close it yourself when done.');
  // deliberately not closing the browser; keep the node process alive
  process.stdin.resume();
})();
