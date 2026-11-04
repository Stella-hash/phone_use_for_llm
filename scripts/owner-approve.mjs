// This utility is for the human owner, never exposed as an MCP tool.
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
const output = path.resolve(outputFile);
assertPrivate(path.dirname(output));
let reviewDirectory, reviewFile, rl, stagedFile, reservedIdentity;
const identity = stat => `${stat.dev}:${stat.ino}`;
function removeReview() {
  if (reviewFile && fs.existsSync(reviewFile)) {
    // Try unlink even if making a read-only file writable failed.
    try { fs.chmodSync(reviewFile, 0o600); } finally { fs.unlinkSync(reviewFile); }
  }
  if (reviewDirectory) fs.rmdirSync(reviewDirectory);
  reviewFile = reviewDirectory = undefined;
}
try {
  // Capture the directory before permission/setup operations can throw.
  reviewDirectory = fs.mkdtempSync(path.join(path.dirname(path.resolve(keyFile)), 'approval-review-'));
  privateDirectory(reviewDirectory);
  reviewFile = path.join(reviewDirectory, 'request.json');
  writePrivate(reviewFile, JSON.stringify(request, null, 2) + '\n');
  fs.chmodSync(reviewFile, 0o400);
  const reviewed = readPrivateSnapshot(reviewFile, 65536);
  console.log(`Review this normalized, read-only owner snapshot in your editor: ${reviewFile}`);
  console.log(`Tool: ${request.name}; SHA-256: ${digest}. Input text is not printed here.`);
  rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`After reviewing its full contents and effects, type APPROVE ${digest.slice(0, 12)}: `);
  if (answer !== `APPROVE ${digest.slice(0, 12)}`) throw new Error('Owner approval not supplied');
  for (const [file, prior] of [[requestFile, original], [reviewFile, reviewed]]) {
    const current = readPrivateSnapshot(file, 65536);
    if (current.identity !== prior.identity || current.digest !== prior.digest) throw new Error('Request changed during review; no approval issued');
  }
  rl.close(); rl = undefined;
  // Cleanup must succeed before creating or publishing an approval.
  removeReview();
  request.arguments.approval = signApproval(readPrivate(keyFile, 4096), security.config.ownerId, request.name, request.arguments, Date.now() + 120000);
  stagedFile = path.join(path.dirname(output), `.approval-output-${randomUUID()}.tmp`);
  writePrivate(stagedFile, JSON.stringify(request, null, 2) + '\n');
  // Reserve an empty destination exclusively: an existing approval is never
  // overwritten, including when two owner signers choose the same output path.
  // The host owner remains trusted (see private-files.ts); this is not an OS sandbox.
  const fd = fs.openSync(output, 'wx', 0o600);
  try { reservedIdentity = identity(fs.fstatSync(fd, { bigint: true })); } finally { fs.closeSync(fd); }
  if (identity(fs.lstatSync(output, { bigint: true })) !== reservedIdentity) throw new Error('Approval output changed');
  // Same-directory rename publishes the complete, permissioned file atomically.
  // No fallible cleanup remains after publication.
  fs.renameSync(stagedFile, output);
  stagedFile = reservedIdentity = undefined;
} finally {
  rl?.close();
  try { removeReview(); } finally {
    try {
      if (reservedIdentity && fs.existsSync(output) && identity(fs.lstatSync(output, { bigint: true })) === reservedIdentity) fs.unlinkSync(output);
    } finally {
      if (stagedFile && fs.existsSync(stagedFile)) fs.unlinkSync(stagedFile);
    }
  }
}
console.log('Approval saved for this exact request; expires in 2 minutes. Send once; recover by requestId if transport fails.');
