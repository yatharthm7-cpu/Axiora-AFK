// Vercel does not consistently resolve multi-segment requests through the
// top-level catch-all function. Route fleet actions explicitly and reuse the
// same authenticated backend relay.
module.exports = require('../[...path].js');
