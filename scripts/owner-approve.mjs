// This utility is for the human owner, never exposed as an MCP tool.
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { signApproval, OwnerSecurity, canonical } from '../dist/security.js';
import { readPrivate, readPrivateSnapshot, writePrivate, assertPrivate, privateDirectory } from '../dist/private-files.js';
import { boundedValue } from '../dist/limits.js';
import { strictJson } from '../dist/json.js';
import { canonicalArguments } from '../dist/operation.js';
const [configFile, keyFile, requestFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: node scripts/owner-approve.mjs SECURITY_FILE SIGNING_KEY REQUEST_FILE OUTPUT_FILE');
const security = new OwnerSecurity(configFile);
const original = readPrivateSnapshot(requestFile, 65536);
const request = strictJson(original.text);
boundedValue(request);
if (typeof request.name !== 'string' || !request.arguments || typeof request.arguments.requestId !== 'string') throw new Error('An exact tool name, arguments and requestId are required');
request.arguments = canonicalArguments(request.name, request.arguments);
const digest = createHash('sha256').update(canonical(request)).digest('hex');
assertPrivate(path.dirname(path.resolve(keyFile)));
const reviewDirectory = privateDirectory(fs.mkdtempSync(path.join(path.dirname(path.resolve(keyFile)), 'approval-review-')));
const reviewFile = path.join(reviewDirectory, 'request.json');
writePrivate(reviewFile, JSON.stringify(request, null, 2) + '\n');
fs.chmodSync(reviewFile, 0o400);
const reviewed = readPrivateSnapshot(reviewFile, 65536);
console.log(`Review this normalized, read-only owner snapshot in your editor: ${reviewFile}`);
console.log(`Tool: ${request.name}; SHA-256: ${digest}. Input text is not printed here.`);
const rl = createInterface({ input: stdin, output: stdout });
try {
  const answer = await rl.question(`After reviewing its full contents and effects, type APPROVE ${digest.slice(0, 12)}: `);
  if (answer !== `APPROVE ${digest.slice(0, 12)}`) throw new Error('Owner approval not supplied');
  for (const [file, prior] of [[requestFile, original], [reviewFile, reviewed]]) {
    const current = readPrivateSnapshot(file, 65536);
    if (current.identity !== prior.identity || current.digest !== prior.digest) throw new Error('Request changed during review; no approval issued');
  }
  request.arguments.approval = signApproval(readPrivate(keyFile, 4096), security.config.ownerId, request.name, request.arguments, Date.now() + 120000);
  assertPrivate(path.dirname(path.resolve(outputFile)));
  writePrivate(outputFile, JSON.stringify(request, null, 2) + '\n');
  console.log('Approval saved for this exact request; expires in 2 minutes. Send once; recover by requestId if transport fails.');
} finally {
  rl.close();
  fs.chmodSync(reviewFile, 0o600);
  fs.unlinkSync(reviewFile);
  fs.rmdirSync(reviewDirectory);
}
