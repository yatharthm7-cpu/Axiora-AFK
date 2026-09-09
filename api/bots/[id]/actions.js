// Explicit route for per-bot dashboard actions on Vercel. The shared relay
// derives the upstream path from request.url when no catch-all value exists.
module.exports = require('../../[...path].js');
