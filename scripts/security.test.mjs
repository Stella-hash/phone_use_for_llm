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
import { normalizeKey, actionBinding, expertGrantableTools } from '../dist/operation.js';
import { localDeviceSerial } from '../dist/device.js';
import { strictJson } from '../dist/json.js';

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
    catch { if (n > 400 || child.exitCode !== null) throw Error('Fixture startup failed or exceeded 20 seconds: ' + stderr); await new Promise(r => setTimeout(r, 50)); }
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

test('expert grants reject unknown, legacy, read and key tools before service construction', () => {
  const owner = fixtureOwner(fresh('exact-grants'), {
    expertSandbox: { trustedOperators: true, disposablePhone: true, isolatedEnvironment: true, acceptsRisk: true,
      grants: [{ package: 'org.example.game', tools: [...expertGrantableTools] }] },
  });
  const security = new OwnerSecurity(owner.file);
  const args = { requestId: 'exact-grant-fixture', expectedPackage: 'org.example.game' };
  for (const name of expertGrantableTools) security.authorize(name, args);
  for (const name of ['android_future_action', 'android_install_app', 'android_connect_wifi', 'android_take_screenshot', 'android_device_info', 'android_press_key']) {
    owner.config.expertSandbox.grants[0].tools = [name];
    fs.writeFileSync(owner.file, JSON.stringify(owner.config));
    assert.throws(() => new OwnerSecurity(owner.file), /Invalid owner security configuration/);
  }
  // Even accidental in-memory insertion cannot turn an unknown tool into a grant.
  security.config.expertSandbox.grants[0].tools.push('android_future_action');
  assert.throws(() => security.authorize('android_future_action', args), /OWNER_APPROVAL_REQUIRED/);
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
  for (const name of expertGrantableTools) assert.match(catalog.find(tool => tool.name === name)?.description || '', /explicit local owner grant/);
  for (const name of ['android_press_key', 'android_device_info']) assert.match(catalog.find(tool => tool.name === name).description, /cannot be pregranted/);
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
  assert(result.isError, JSON.stringify(result));
  assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.callOutcome, 'policy_drift');
  assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.execution, 'acknowledged');
  assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.screenshotAvailable, false);
  assert(!result.content.some(c => c.type === 'image'));
  assert(!JSON.stringify(f.rows()).match(/uiautomator|screencap/));
});

test('lock appearing after input preserves acknowledgement and prevents all post-action UI reads', async t => {
  const f = await fixtureServer(t, { PHONE_TEST_LOCK_AFTER_INPUT: '1' });
  const result = await f.signed('android_tap', { x: 1, y: 2, requestId: 'lock-transition-001' });
  assert(result.isError); assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.execution, 'acknowledged');
  assert(!JSON.stringify(f.rows()).match(/uiautomator|screencap/));
});

test('key aliases share signing, dispatch and receipt semantics and cannot be pregranted', async t => {
  const f = await fixtureServer(t);
  for (const [key, canonical] of [[' soft_sleep ', 'KEYCODE_SOFT_SLEEP'], ['00276', 'KEYCODE_SOFT_SLEEP'], [' keycode_sleep ', 'KEYCODE_SLEEP'], ['00026', 'KEYCODE_POWER'], ['224', 'KEYCODE_WAKEUP']]) {
    assert.equal(normalizeKey(key), canonical);
    const args = { key, requestId: 'alias-' + randomUUID(), expectedPackage: 'org.example.game' };
    const refused = await f.client.callTool({ name: 'android_press_key', arguments: args });
    assert(refused.isError); assert(!f.rows().some(r => r.args[0] === 'input'));
  }
  const result = await f.signed('android_press_key', { key: ' 00276 ', requestId: 'signed-sleep-alias' });
  assert(!result.isError);
  assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.requestBinding.normalizedKey, 'KEYCODE_SOFT_SLEEP');
  assert(f.rows().some(r => r.args[0] === 'input' && r.args[2] === 'KEYCODE_SOFT_SLEEP'));
  const owner = fixtureOwner(fresh('bad-key-grant'), { expertSandbox: { trustedOperators: true, disposablePhone: true,
    isolatedEnvironment: true, acceptsRisk: true, grants: [{ package: 'org.example.game', tools: ['android_press_key'] }] } });
  assert.throws(() => new OwnerSecurity(owner.file), /configuration/);
});

test('Chrome launch and disallowed URL fail before input; navigation drift keeps acknowledged error receipt', async t => {
  const f = await fixtureServer(t, { PHONE_TEST_PACKAGE: 'com.android.chrome', PHONE_TEST_URL_AFTER_INPUT: 'https://unapproved.example/page' });
  for (const [name, args] of [['android_launch_app', { packageName: 'com.android.chrome' }], ['android_open_url', { url: 'https://unapproved.example/page' }]]) {
    const result = await f.signed(name, { ...args, expectedPackage: 'com.android.chrome', requestId: randomUUID() });
    assert(result.isError);
    assert.equal(texts(result).find(x => x.phoneReceipt).phoneReceipt.execution, 'not_started');
  }
  assert(!f.rows().some(r => ['am','monkey','input'].includes(r.args[0])));
  const result = await f.signed('android_open_url', { url: 'https://fixture.example/page', expectedPackage: 'com.android.chrome', requestId: 'url-post-drift' });
  assert(result.isError);
  const receipt = texts(result).find(x => x.phoneReceipt).phoneReceipt;
  assert.equal(receipt.execution, 'acknowledged'); assert.equal(receipt.callOutcome, 'policy_drift');
  assert(!f.rows().some(r => /uiautomator|screencap/.test(r.args.join(' '))));
});

test('passive reads cannot reserve action IDs; recovery verifies tool and normalized argument digest', async t => {
  const f = await fixtureServer(t); const id = 'read-then-action';
  for (const name of ['android_power_status', 'android_device_info', 'android_list_elements', 'android_take_screenshot'])
    assert((await f.client.callTool({ name, arguments: { requestId: id } })).isError);
  assert.equal(f.rows().length, 0);
  const request = f.owner.authorize({ name: 'android_tap', arguments: { x: 2, y: 3, requestId: id, expectedPackage: 'org.example.game' } });
  const result = await f.client.callTool(request); assert(!result.isError);
  const binding = actionBinding(request.name, request.arguments);
  const recovered = await f.client.callTool({ name: 'android_activity_open', arguments: { requestId: id, receiptOnly: true, expectedTool: binding.tool, expectedArgsDigest: binding.argsDigest } });
  assert.deepEqual(texts(recovered)[0].phoneReceipt.requestBinding, binding);
  const mismatch = await f.client.callTool({ name: 'android_activity_open', arguments: { requestId: id, receiptOnly: true, expectedTool: 'android_swipe', expectedArgsDigest: binding.argsDigest } });
  assert(mismatch.isError);
  assert((await f.signed('android_tap', { x: 8, y: 3, requestId: id })).isError);
  assert.equal(f.rows().filter(r => r.args[0] === 'input' && r.args[1] === 'tap').length, 1);
});

for (const tool of ['android_type_text', 'android_set_text']) for (const [label, env] of [['stable', {}], ['focus', { PHONE_TEST_FOCUS_AFTER_INPUT: 'org.unapproved.dialog' }],
  ['locked', { PHONE_TEST_LOCK_AFTER_INPUT: '1' }], ['url', { PHONE_TEST_URL_AFTER_INPUT: 'https://unapproved.example/page' }]])
test(`${tool} post-check ${label} verifies metadata without reading typed contents`, async t => {
  const f = await fixtureServer(t, { PHONE_TEST_TEXT_SUCCESS: '1', PHONE_TEST_PACKAGE: 'com.android.chrome', ...env });
  const marker = 'SYNTHETIC_PRIVATE_TEXT_' + randomUUID();
  const result = await f.signed(tool, { text: marker, expectedPackage: 'com.android.chrome', requestId: randomUUID() });
  assert.equal(!!result.isError, label !== 'stable');
  const receipt = texts(result).find(x => x.phoneReceipt).phoneReceipt;
  assert.equal(receipt.execution, 'acknowledged');
  assert.equal(receipt.callOutcome, label === 'stable' ? 'completed' : 'policy_drift');
  assert(!JSON.stringify(result).includes(marker));
  const rows = f.rows(); const inputAt = rows.findIndex(r => (r.args[0] === 'input' && r.args[1] === 'text') || r.args.at(-1) === 'dev.gc.agentphone.helper/.UnicodeInstrumentation'); assert(inputAt >= 0);
  assert(!rows.slice(inputAt + 1).some(r => /uiautomator|screencap|DOMSnapshot|Accessibility/.test(r.args.join(' '))));
});

test('strict JSON and local transport validation reject ambiguity without any device discovery', () => {
  const marker = 'SYNTHETIC_PRIVATE_SENTINEL';
  for (const input of [marker, '{"text":' + marker + '}']) {
    assert.throws(() => strictJson(input), error => error.message === 'Invalid JSON document' && !String(error).includes(marker));
  }
  for (const input of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":[{"x":1,"x":2}]}']) assert.throws(() => strictJson(input), /Duplicate/);
  assert.deepEqual(strictJson('{"x":{"a":1},"y":{"a":2},"z":["x",{"a":3}]}'), { x: { a: 1 }, y: { a: 2 }, z: ['x', { a: 3 }] });
  for (const serial of ['192.0.2.1:5555', 'adb-example-guid._adb-tls-connect._tcp', 'adb-example-guid._adb-tls-pairing._tcp', 'device._adb._tcp', 'device._adb_secure._tcp']) assert.throws(() => localDeviceSerial(serial), /wireless/);
  assert.equal(localDeviceSerial('USB_FIXTURE_01'), 'USB_FIXTURE_01'); assert.equal(localDeviceSerial('emulator-5554'), 'emulator-5554');
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
