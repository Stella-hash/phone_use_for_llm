// Local owner utility. It does not contact a phone or a network service.
import { createOwnerSetup } from '../dist/owner-setup.js';
const [directory, signerDirectory, ownerId = 'owner'] = process.argv.slice(2);
if (!directory || !signerDirectory) throw new Error('Usage: node scripts/owner-setup.mjs SERVICE_DIRECTORY SIGNER_DIRECTORY [OWNER_ID]');
const result = createOwnerSetup(directory, signerDirectory, ownerId);
console.log(JSON.stringify(result));
console.log('Configure allowedApps/allowedDomains in security.json, then set PHONE_SECURITY_FILE. Keep the signing key outside agent-accessible files. No phone was accessed.');
