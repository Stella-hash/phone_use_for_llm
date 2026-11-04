// Human review boundary tests use disposable generated keys and synthetic text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixtureOwner } from './fixtures/owner.mjs';
import { writePrivate } from '../dist/private-files.js';
import { OwnerSecurity } from '../dist/security.js';

for (const scenario of ['unchanged', 'source-replaced', 'review-changed', 'duplicate-key']) test(`owner signer: ${scenario}`, async () => {
  fs.mkdirSync('.runtime', { recursive: true });
  const owner = fixtureOwner(fs.mkdtempSync(path.resolve('.runtime/approval-')));
  const dir = path.dirname(owner.file), key = path.join(dir, 'approval.key'), source = path.join(dir, 'request.json'), output = path.join(dir, 'approved.json');
  writePrivate(key, owner.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const request = { name: 'android_press_key', arguments: { key: ' 00276 ', requestId: 'fixture-owner-review' } };
  writePrivate(source, scenario === 'duplicate-key' ? '{"name":"android_tap","name":"android_press_key","arguments":{"key":"276","requestId":"fixture-owner-review"}}' : JSON.stringify(request));
  const child = spawn(process.execPath, ['scripts/owner-approve.mjs', owner.file, key, source, output], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let out = '', err = '', answered = false;
  const timer = setTimeout(() => child.kill(), 30000);
  child.stderr.on('data', c => err += c);
  child.stdout.on('data', c => {
    out += c;
    const approve = out.match(/type (APPROVE [a-f0-9]{12}):/);
    if (!approve || answered) return;
    answered = true;
    const review = out.match(/owner snapshot in your editor: ([^\r\n]+)/)?.[1];
    assert(review && !path.relative(dir, review).startsWith('..'));
    assert.equal(JSON.parse(fs.readFileSync(review, 'utf8')).arguments.key, 'KEYCODE_SOFT_SLEEP');
    if (scenario === 'source-replaced') {
      fs.renameSync(source, source + '.old'); writePrivate(source, JSON.stringify(request));
    } else if (scenario === 'review-changed') {
      fs.chmodSync(review, 0o600); fs.writeFileSync(review, JSON.stringify({ ...request, arguments: { ...request.arguments, key: 'KEYCODE_WAKEUP' } }));
    }
    child.stdin.end(approve[1] + '\n');
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); clearTimeout(timer);
  if (scenario === 'unchanged') {
    assert.equal(code, 0, err); const approved = JSON.parse(fs.readFileSync(output, 'utf8'));
    new OwnerSecurity(owner.file).authorize(approved.name, approved.arguments);
    assert.equal(approved.arguments.key, 'KEYCODE_SOFT_SLEEP');
  } else {
    assert.notEqual(code, 0); assert(!fs.existsSync(output));
    assert.match(err, scenario === 'duplicate-key' ? /Duplicate JSON key/ : /changed during review/);
  }
});
