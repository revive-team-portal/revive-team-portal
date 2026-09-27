// Catering is now computed inside the single unified Shopify line-item pass
// (_hemealssync). Kept as a thin alias so nothing else breaks.
const { syncHeatEat } = require('./_hemealssync');
module.exports = { syncCatering: syncHeatEat };
