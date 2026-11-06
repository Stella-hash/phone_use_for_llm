// Owner-operated local export; never exposed as an MCP filesystem capability.
import { OwnerSecurity } from '../dist/security.js';
import { KeepsakeStore } from '../dist/keepsakes.js';
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw new Error('Usage: node scripts/export-keepsakes.mjs NEW_PRIVATE_DIRECTORY');
const security = new OwnerSecurity(process.env.PHONE_SECURITY_FILE);
const store = new KeepsakeStore(security.directory, security.config.screenshotKeepsakes);
console.log(JSON.stringify(store.exportTo(destination)));
