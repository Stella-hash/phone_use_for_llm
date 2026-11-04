// Defensive contract tests against disposable fixtures, never a real device.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixtureOwner } from './fixtures/owner.mjs';
import { OwnerSecurity, signApproval } from '../dist/security.js';
import { ActivityJournal } from '../dist/activity.js';
import { ImageStore } from '../dist/image-store.js';
import { LIMITS, boundedValue } from '../dist/limits.js';
import { UiInspector } from '../dist/ui.js';
import { assertPrivate } from '../dist/private-files.js';
import { Executor } from '../dist/executor.js';

fs.mkdirSync('.runtime', { recursive: true });
const fresh = name => fs.mkdtempSync(path.resolve('.runtime/' + name + '-'));
const texts = r => r.content.filter(c => c.type === 'text').map(c => { try { return JSON.parse(c.text); } catch { return c.text; } });
async function fixtureServer(t, env = {}, config = {}) {
  const dir = fresh('security'); const owner = fixtureOwner(dir, config); const trace = path.join(dir, 'trace.jsonl');
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/fake-adb.mjs', 'dist/phone.js'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      PHONE_SECURITY_FILE: owner.file, PHONE_DEVICE: 'synthetic-device', PHONE_PORT: String(port), PHONE_TEST_TRACE: trace,
      PHONE_TEST_AWAKE: '1', PHONE_TEST_PACKAGE: 'org.example.game', PHONE_SUMMARY_API_KEY: '', PHONE_SUMMARY_KEY_FILE: '', ...env },
  });
  let stderr = ''; child.stderr.on('data', c => { stderr += c; });
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'defensive-fixture', version: '1' });
  t.after(async () => { await client.close(); if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); } });
  for (let n = 0; ; n++) {
    try { assert((await fetch(endpoint + '/healthz', { headers: owner.headers })).ok); break; }
    catch { if (n > 160 || child.exitCode !== null) throw Error(stderr); await new Promise(r => setTimeout(r, 50)); }
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp'), { requestInit: { headers: owner.headers } }));
  const rows = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(r => JSON.parse(r)) : [];
  const signed = (name, args) => client.callTool(owner.authorize({ name, arguments: { expectedPackage: 'org.example.game', ...args } }));
  return { client, owner, rows, endpoint, dir, signed };
}

test('missing config fails before listener/device; owner binding and exact approvals cannot be changed by caller claims', () => {
  assert.throws(() => new OwnerSecurity(undefined), /required/);
  const dir = fresh('owner'); const owner = fixtureOwner(dir); const security = new OwnerSecurity(owner.file);
  assert(security.authenticate(owner.headers.Authorization));
  assert(!security.authenticate('Bearer ' + 'x'.repeat(43)));
  const args = { x: 1, y: 2, expectedPackage: 'org.example.game', requestId: 'owner-approval-test' };
  assert.throws(() => security.authorize('android_tap', args), /OWNER_APPROVAL_REQUIRED/);
  args.approval = signApproval(owner.privateKey, owner.config.ownerId, 'android_tap', args, Date.now() + 30000);
  security.authorize('android_tap', args);
  for (const changed of [{ ...args, x: 3 }, { ...args, context: { actor: 'owner' } }, { ...args, requestId: 'another-request-id' }])
    assert.throws(() => security.authorize('android_tap', changed), /INVALID/);
  const expired = { ...args, approval: signApproval(owner.privateKey, owner.config.ownerId, 'android_tap', args, Date.now() - 1) };
  assert.throws(() => security.authorize('android_tap', expired), /REQUIRED/);
  for (const url of ['http://fixture.example/', 'https://127.0.0.1/', 'https://fixture.example.invalid/', 'https://a.fixture.example/', 'https://user:pass@fixture.example/'])
    assert.throws(() => security.url(url), /URL_NOT_ALLOWED/);
  assert.equal(security.url('https://fixture.example/page'), 'https://fixture.example/page');
  assertPrivate(security.directory);
  fs.writeFileSync(owner.file, JSON.stringify({ ...owner.config, ownerId: 'different-owner' }));
  assert.throws(() => new OwnerSecurity(owner.file), /ownership/);
});

test('game grants apply only to configured touch operations; expert grants still require app/lock/auth boundaries', () => {
  const owner = fixtureOwner(fresh('grant'), { gameGrants: [{ package: 'org.example.game', tools: ['android_tap'], disposableOfflineGame: true }],
    expertSandbox: { trustedOperators: true, disposablePhone: true, isolatedEnvironment: true, acceptsRisk: true,
      grants: [{ package: 'org.example.game', tools: ['android_swipe'] }] } });
  const security = new OwnerSecurity(owner.file);
  const args = { requestId: 'game-request-001', expectedPackage: 'org.example.game' };
  security.authorize('android_tap', args); security.authorize('android_swipe', args);
  assert.throws(() => security.authorize('android_type_text', args), /REQUIRED/);
  assert.throws(() => security.authorize('android_tap', { ...args, expectedPackage: 'org.other.game' }), /APP_NOT_ALLOWED/);
  assert.throws(() => security.authorize('android_press_key', { ...args, key: 'WAKEUP' }), /REQUIRED/);
});

test('small defensive limit fixtures reject deep/long collections and bound XML before parsing', () => {
  assert.throws(() => boundedValue({ text: 'x'.repeat(LIMITS.stringLength + 1) }), /FIELD_LIMIT/);
  assert.throws(() => boundedValue(Array(513).fill(0)), /COLLECTION_LIMIT/);
  let value = 1; for (let n = 0; n < 14; n++) value = { value };
  assert.throws(() => boundedValue(value), /STRUCTURE_LIMIT/);
  const xml = '<?xml version="1.0"?><hierarchy>' + '<node>'.repeat(49) + '</node>'.repeat(49) + '</hierarchy>';
  assert.throws(() => new UiInspector({ adb: () => Buffer.from(xml) }).getElements('fixture'), /depth limit/);
});

test('retention removes source text but keeps replay tombstones; ledger capacity fails before new work', () => {
  const journal = new ActivityJournal(fresh('retention'), { events: 3, requestIds: 2, retentionMs: 1 });
  const id = journal.begin('android_tap', {}, {}, 'phone', 'retained-request-one');
  journal.recordExecution(id, 'acknowledged'); journal.finish(id, 'completed', { observation: { elements: [{ text: 'synthetic source text' }] } });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); journal.maintain();
  assert.equal(journal.open(id), null);
  assert.equal(journal.findRequest('retained-request-one').execution, 'unknown_expired');
  assert.throws(() => journal.begin('android_tap', {}, {}, 'phone', 'retained-request-one'), /UNIQUE/);
  const next = journal.begin('android_tap', {}, {}, 'phone', 'retained-request-two'); journal.finish(next, 'completed', {});
  assert.throws(() => journal.begin('android_tap', {}, {}, 'phone', 'retained-request-three'), /capacity/);
  journal.close();
});

test('authentication, field/body/batch caps and legacy filtering reject requests without device work', async t => {
  const f = await fixtureServer(t); const before = f.rows().length;
  for (const headers of [{}, { Authorization: 'Bearer ' + 'x'.repeat(43) }]) assert.equal((await fetch(f.endpoint + '/healthz', { headers })).status, 401);
  const headers = { ...f.owner.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const body of [JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]), JSON.stringify({ text: 'x'.repeat(65536) })])
    assert.equal((await fetch(f.endpoint + '/mcp', { method: 'POST', headers, body })).status, 413);
  const catalog = (await f.client.listTools()).tools;
  assert.equal(catalog.length, 26);
  for (const name of ['android_install_app', 'android_list_devices', 'android_connect_wifi', 'android_save_screenshot']) {
    assert(!catalog.some(t => t.name === name));
    assert((await f.client.callTool({ name, arguments: {} })).isError);
  }
  assert((await f.client.callTool({ name: 'android_tap', arguments: { x: 1, y: 2 } })).isError);
  assert((await f.client.callTool({ name: 'android_tap', arguments: { x: 1, y: 2, requestId: 'no-approval-001', expectedPackage: 'org.example.game' } })).isError);
  assert.equal(f.rows().length, before);
  const ok = await f.signed('android_tap', { x: 1, y: 2, requestId: 'approved-input-001' });
  assert(!ok.isError, JSON.stringify(ok));
  const duplicate = await f.signed('android_tap', { x: 1, y: 2, requestId: 'approved-input-001' });
  assert(duplicate.isError); assert.equal(f.rows().filter(r => r.args[0] === 'input' && r.args[1] === 'tap').length, 1);
});

for (const lock of ['locked', 'unknown']) test(`${lock} lock state blocks all UI reads/input without waking or capturing`, async t => {
  const f = await fixtureServer(t, { PHONE_TEST_LOCK: lock, PHONE_AUTO_WAKE: '1' });
  for (const name of ['android_take_screenshot', 'android_list_elements', 'android_list_apps'])
    assert((await f.client.callTool({ name, arguments: {} })).isError);
  assert((await f.signed('android_tap', { x: 1, y: 2, requestId: 'locked-input-001' })).isError);
  const power = await f.client.callTool({ name: 'android_power_status', arguments: {} }); assert(!power.isError);
  assert(!JSON.stringify(f.rows()).match(/uiautomator|screencap|KEYCODE_WAKEUP|dismiss-keyguard|instrument|"tap"/));
});

test('raw text never appears in errors or journal; failed inputs remain unconfirmed; queue has a finite ceiling', async t => {
  const f = await fixtureServer(t, {}, { gameGrants: [{ package: 'org.example.game', tools: ['android_tap'], disposableOfflineGame: true }] });
  const marker = 'SYNTHETIC_INPUT_' + randomUUID();
  const result = await f.signed('android_type_text', { text: marker, requestId: 'typed-input-failure' });
  assert(result.isError); assert(!JSON.stringify(result).includes(marker));
  assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.execution, 'unconfirmed');
  const stored = await f.client.callTool({ name: 'android_activity_open', arguments: { requestId: 'typed-input-failure' } });
  assert(!JSON.stringify(stored).includes(marker));
  for (const filename of fs.readdirSync(path.join(f.dir, 'journal')).filter(n => n.startsWith('activity.sqlite3')))
    assert(!fs.readFileSync(path.join(f.dir, 'journal', filename)).includes(Buffer.from(marker)));
  const calls = Array.from({ length: LIMITS.queue + 1 }, (_, n) => f.client.callTool({ name: 'android_tap', arguments: {
    x: 1, y: 2, requestId: 'queue-request-' + n, expectedPackage: 'org.example.game', observeAfterMs: 80, imageMode: 'deferred' } }));
  const results = await Promise.all(calls);
  assert(results.some(r => r.isError && JSON.stringify(r).includes('QUEUE_FULL')));
  assert(results.some(r => !r.isError));
});

test('image paths stay inside the owner store and expiry removes evidence without accessing ADB', () => {
  const owner = fixtureOwner(fresh('images')); const security = new OwnerSecurity(owner.file); const store = new ImageStore(security.directory);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC4sAAAAASUVORK5CYII=', 'base64');
  const reference = store.save(1, png); assert.deepEqual(store.open(reference), png);
  assert.throws(() => store.open({ storage: 'owner-host', filename: '../token.key' }));
  const file = path.join(store.directory, reference.filename); assertPrivate(file);
  fs.utimesSync(file, new Date(0), new Date(0)); store.prune();
  assert(!fs.existsSync(file)); assert.throws(() => store.open(reference));
});

test('focus changes after acknowledged input omit UI instead of erasing the receipt or reading the new app', async t => {
  const f = await fixtureServer(t, { PHONE_TEST_FOCUS_AFTER_INPUT: 'org.unapproved.dialog' });
  const result = await f.signed('android_tap', { x: 1, y: 2, requestId: 'focus-transition-001' });
  assert(!result.isError, JSON.stringify(result));
  assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.execution, 'acknowledged');
  assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.screenshotAvailable, false);
  assert(!result.content.some(c => c.type === 'image'));
  assert(!JSON.stringify(f.rows()).match(/uiautomator|screencap/));
});

test('lock appearing after input preserves acknowledgement and prevents all post-action UI reads', async t => {
  const f = await fixtureServer(t, { PHONE_TEST_LOCK_AFTER_INPUT: '1' });
  const result = await f.signed('android_tap', { x: 1, y: 2, requestId: 'lock-transition-001' });
  assert(!result.isError); assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.execution, 'acknowledged');
  assert(!JSON.stringify(f.rows()).match(/uiautomator|screencap/));
});

test('journal admission failure does not prevent an authenticated saved-receipt read', async () => {
  const owner = fixtureOwner(fresh('full-journal')); const security = new OwnerSecurity(owner.file);
  const executor = new Executor(security, 'synthetic-device', { callTool: () => { throw Error('No device work allowed'); } }, [{
    name: 'android_activity_open', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, receiptOnly: { type: 'boolean' } } },
  }]);
  try {
    const id = executor.journal.begin('android_tap', {}, {}, 'phone', 'capacity-recovery-001');
    executor.journal.recordExecution(id, 'acknowledged'); executor.journal.finish(id, 'completed', {});
    executor.journal.begin = () => { throw Error('synthetic capacity limit'); };
    const result = await executor.call('android_activity_open', { requestId: 'capacity-recovery-001', receiptOnly: true });
    assert(!result.isError); assert.equal(texts(result)[0].phoneReceipt.execution, 'acknowledged');
    assert.equal(texts(result).find(x => x.phoneActivity).phoneActivity.historyReadNotRecorded, true);
  } finally { await executor.close(); }
});
