// Owner-operated local export; never exposed as an MCP filesystem capability.
import { OwnerSecurity } from '../dist/security.js';
import { ClipStore } from '../dist/clip-store.js';
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw new Error('Usage: node scripts/export-clip-keepsakes.mjs NEW_PRIVATE_DIRECTORY');
const security = new OwnerSecurity(process.env.PHONE_SECURITY_FILE), options = security.config.shortClips;
const store = new ClipStore(security.directory, {
  cacheMaxAgeMs: options.cache.maxAgeMs, cacheMaxBytes: options.cache.maxBytes, cacheMaxCount: options.cache.maxCount,
  keepsakesEnabled: options.keepsakes.enabled, keepsakeMaxBytes: options.keepsakes.maxBytes, keepsakeMaxCount: options.keepsakes.maxCount,
});
console.log(JSON.stringify(store.exportTo(destination)));
