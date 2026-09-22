// Starts the API on a free port with the demo data and prints the port. Used by the web app's screen tests.
import { boot } from './helpers.js';
const t = await boot();
console.log('PORT=' + t.port);
setInterval(() => {}, 1 << 30);
