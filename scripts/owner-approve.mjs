// This utility is for the human owner, never exposed as an MCP tool.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { signApproval, OwnerSecurity, canonical } from '../dist/security.js';
import { readPrivate, writePrivate, assertPrivate } from '../dist/private-files.js';
import { boundedValue } from '../dist/limits.js';
const [configFile, keyFile, requestFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: node scripts/owner-approve.mjs SECURITY_FILE SIGNING_KEY REQUEST_FILE OUTPUT_FILE');
const security = new OwnerSecurity(configFile);
const request = JSON.parse(readPrivate(requestFile, 65536));
boundedValue(request);
if (typeof request.name !== 'string' || !request.arguments || typeof request.arguments.requestId !== 'string') throw new Error('An exact tool name, arguments and requestId are required');
delete request.arguments.approval;
const digest = createHash('sha256').update(canonical(request)).digest('hex');
console.log(`Review the exact request file in your editor: ${path.resolve(requestFile)}`);
console.log(`Tool: ${request.name}; SHA-256: ${digest}. Input text is not printed here.`);
const rl = createInterface({ input: stdin, output: stdout });
try {
  const answer = await rl.question(`After reviewing its full contents and effects, type APPROVE ${digest.slice(0, 12)}: `);
  if (answer !== `APPROVE ${digest.slice(0, 12)}`) throw new Error('Owner approval not supplied');
} finally { rl.close(); }
request.arguments.approval = signApproval(readPrivate(keyFile, 4096), security.config.ownerId, request.name, request.arguments, Date.now() + 120000);
assertPrivate(path.dirname(path.resolve(outputFile)));
writePrivate(outputFile, JSON.stringify(request, null, 2) + '\n');
console.log('Approval saved for this exact request; expires in 2 minutes. Send once; recover by requestId if transport fails.');
