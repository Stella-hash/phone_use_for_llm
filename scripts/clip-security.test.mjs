import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureOwner } from './fixtures/owner.mjs';
import { OwnerSecurity, signApproval } from '../dist/security.js';
import { Executor } from '../dist/executor.js';
import { clipTools } from '../dist/clip-tools.js';
import { captureShortClip, ClipCaptureError } from '../dist/clip-capture.js';
import { ClipStore } from '../dist/clip-store.js';
import { withDeadline } from '../dist/deadline.js';
import { actionBinding, isInputOperation } from '../dist/operation.js';

fs.mkdirSync('.runtime', { recursive: true });
const fresh = () => fs.mkdtempSync(path.resolve('.runtime/clip-security-'));
const config = { enabled: true, allowedApps: ['org.example.game'], acceptsTransientScreenContent: true, recorderPath: process.execPath };
const args = { expectedPackage: 'org.example.game', expectedDisplay: { width: 100, height: 200 }, durationMs: 1000, requestId: 'clip-request-001' };
const text = result => result.content.filter(item => item.type === 'text').map(item => { try { return JSON.parse(item.text); } catch { return item.text; } });
function owner(extra = {}) { const fixture = fixtureOwner(fresh(), { shortClips: config, ...extra }); return { ...fixture, security: new OwnerSecurity(fixture.file) }; }
function catalog() {
  return [...structuredClone(clipTools).map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, properties: {
    ...tool.inputSchema.properties, requestId: { type: 'string' }, context: { type: 'object' }, approval: { type: 'object' },
  } } })), { name: 'android_activity_open', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, receiptOnly: { type: 'boolean' } } } }];
}
function executor(fixture) {
  const result = new Executor(fixture.security, 'synthetic-device', { callTool() { throw Error('Unexpected upstream phone access'); } }, catalog());
  result.adb = new Proxy({}, { get() { throw Error('Unexpected phone access'); } });
  return result;
}

test('clip configuration is off by default and rejects browser, unknown app, missing acknowledgement and unlimited budgets', () => {
  const disabled = owner({ shortClips: undefined });
  assert.equal(disabled.security.config.shortClips.enabled, false);
  assert.throws(() => disabled.security.authorize('android_capture_clip', args), /CLIPS_DISABLED/);
  assert.equal(fs.existsSync(path.join(disabled.security.directory, 'clips')), false);
  for (const change of [{ allowedApps: ['com.android.chrome'] }, { allowedApps: ['org.other.game'] },
    { acceptsTransientScreenContent: false }, { recorderPath: undefined }, { cache: { maxBytes: null } }, { keepsakes: { maxCount: null } }])
    assert.throws(() => owner({ shortClips: { ...config, ...change } }), /Invalid owner security configuration/);
});

test('video-only is request-bound; a tap needs exact clip-tool authority and cannot borrow an ordinary tap grant', () => {
  const f = owner({ gameGrants: [{ package: 'org.example.game', tools: ['android_tap'], disposableOfflineGame: true }] });
  assert.equal(isInputOperation('android_capture_clip', args), true);
  f.security.authorize('android_capture_clip', args);
  assert.throws(() => f.security.authorize('android_capture_clip', { ...args, requestId: undefined }), /REQUEST_ID_REQUIRED/);
  const tapped = { ...args, tap: { x: 1, y: 2 } };
  assert.throws(() => f.security.authorize('android_capture_clip', tapped), /OWNER_APPROVAL_REQUIRED/);
  const approved = { ...tapped, approval: signApproval(f.privateKey, f.config.ownerId, 'android_capture_clip', tapped, Date.now() + 30000) };
  f.security.authorize('android_capture_clip', approved);
  for (const change of [{ tap: { x: 2, y: 2 } }, { expectedDisplay: { width: 200, height: 100 } },
    { durationMs: 2000 }, { requestId: 'clip-request-002' }])
    assert.throws(() => f.security.authorize('android_capture_clip', { ...approved, ...change }), /OWNER_APPROVAL_INVALID/);
  assert.throws(() => f.security.authorize('android_capture_clip', { ...approved, context: { private: true } }), /PRIVATE_CALL/);
  assert.throws(() => f.security.authorize('android_capture_clip', { ...args, expectedPackage: 'com.android.chrome' }), /CLIP_APP_NOT_ALLOWED/);
  const granted = owner({ gameGrants: [{ package: 'org.example.game', tools: ['android_capture_clip'], disposableOfflineGame: true }] });
  granted.security.authorize('android_capture_clip', tapped);
  assert.throws(() => granted.security.authorize('android_tap', { ...args, x: 1, y: 2 }), /OWNER_APPROVAL_REQUIRED/);
});

test('capture failure after a tap preserves acknowledgement, clip identity and exact request recovery without replay', async () => {
  const f = owner({ gameGrants: [{ package: 'org.example.game', tools: ['android_capture_clip'], disposableOfflineGame: true }] });
  const run = executor(f); let calls = 0;
  run.captureClip = async (_adb, _ui, _device, store, eventId, _input, execution) => {
    calls++; const allocated = store.allocate(eventId); execution('unconfirmed'); execution('acknowledged');
    store.fail(allocated.id, { error: 'CLIP_RECORDER_NOT_FINALIZED', inputState: 'acknowledged' });
    throw new ClipCaptureError('CLIP_RECORDER_NOT_FINALIZED', { clipId: allocated.id, tapState: 'acknowledged', mediaStatus: 'failed', failureReceiptSaved: true, automaticRetry: false });
  };
  try {
    const input = { ...args, tap: { x: 1, y: 2 } }, failed = await run.call('android_capture_clip', input);
    assert(failed.isError);
    const receipt = text(failed).find(value => value.phoneReceipt).phoneReceipt;
    assert.equal(receipt.execution, 'acknowledged'); assert.equal(receipt.callOutcome, 'error');
    assert.equal(receipt.clip.tapState, 'acknowledged'); assert.equal(receipt.clip.automaticRetry, false);
    assert.equal(receipt.requestBinding.argsDigest, actionBinding('android_capture_clip', input).argsDigest);
    const recovered = await run.call('android_activity_open', { requestId: args.requestId, receiptOnly: true });
    assert.deepEqual(text(recovered)[0].phoneReceipt, receipt);
    assert.match(JSON.stringify(await run.call('android_capture_clip', input)), /REQUEST_ALREADY_RECORDED/);
    assert.match(JSON.stringify(await run.call('android_capture_clip', { ...input, durationMs: 2000 })), /REQUEST_BINDING_MISMATCH/);
    assert.equal(calls, 1);
  } finally { await run.close(); }
});

test('video-only requests never replay and host reads survive journal admission failure without touching a phone', async () => {
  const f = owner(), run = executor(f); let calls = 0;
  run.captureClip = async (_adb, _ui, _device, store, eventId, _input, execution) => {
    calls++; const allocated = store.allocate(eventId); execution('unconfirmed');
    store.fail(allocated.id, { error: 'CLIP_RECORDER_FAILED_BEFORE_INPUT', inputState: 'not_requested' });
    throw new ClipCaptureError('CLIP_RECORDER_FAILED_BEFORE_INPUT', { clipId: allocated.id, tapState: 'not_requested', mediaStatus: 'failed', failureReceiptSaved: true, automaticRetry: false });
  };
  try {
    const first = await run.call('android_capture_clip', args);
    assert.equal(text(first).find(value => value.phoneReceipt).phoneReceipt.execution, 'unconfirmed');
    assert.match(JSON.stringify(await run.call('android_capture_clip', args)), /REQUEST_ALREADY_RECORDED/);
    assert.equal(calls, 1);
    run.journal.begin = () => { throw Error('Synthetic disk pressure'); };
    const listing = await run.call('android_clip_open', {});
    assert.equal(listing.isError, undefined); assert(text(listing).some(value => value.phoneActivity?.storageReadNotRecorded));
    assert.equal(text(listing)[0].phoneContacted, false);
    assert.match(JSON.stringify(await run.call('android_capture_clip', { ...args, requestId: 'clip-storage-full-002' })), /JOURNAL_UNAVAILABLE/);
    assert.equal(calls, 1);
  } finally { await run.close(); }
});

test('host keep has its own opt-in and never grants phone input', () => {
  const disabled = owner();
  assert.throws(() => disabled.security.authorize('android_clip_keep', { id: 'unused', title: 'moment', requestId: 'clip-keep-001' }), /CLIP_KEEPSAKES_DISABLED/);
  const enabled = owner({ shortClips: { ...config, keepsakes: { enabled: true } } });
  enabled.security.authorize('android_clip_keep', { id: 'unused', title: 'moment', requestId: 'clip-keep-001' });
  assert.throws(() => enabled.security.authorize('android_clip_keep', { id: 'unused', title: 'moment', requestId: 'clip-keep-001', context: { private: true } }), /PRIVATE_CALL/);
  assert.throws(() => enabled.security.authorize('android_capture_clip', { ...args, tap: { x: 1, y: 2 } }), /OWNER_APPROVAL_REQUIRED/);
});

test('unsupported capture host fails explicitly before phone access or allocation', { skip: process.platform === 'linux' }, async () => {
  const f = owner(); let attempted = false;
  const forbidden = new Proxy({}, { get() { attempted = true; throw Error('Unexpected access'); } });
  await assert.rejects(() => captureShortClip(forbidden, forbidden, 'synthetic-device', forbidden, 1,
    { expectedPackage: args.expectedPackage, expectedDisplay: args.expectedDisplay }, () => {}, f.security), /CLIP_CAPTURE_REQUIRES_LINUX_HOST/);
  assert.equal(attempted, false);
});

test('Linux capture guards reject asleep, locked, changed app/display and password UI before starting a recorder', { skip: process.platform !== 'linux' }, async () => {
  const f = owner();
  for (const issue of ['asleep', 'locked', 'app', 'display', 'password', 'rotate-during-ui']) {
    const commands = []; let rotated = false;
    const adb = { getFocusedPackage: () => issue === 'app' ? 'com.android.chrome' : 'org.example.game',
      shell(_device, ...command) {
        commands.push(command);
        if (command.join(' ') === 'dumpsys window policy') return 'showing=' + (issue === 'locked' ? 'true' : 'false');
        if (command.join(' ') === 'dumpsys power') return 'mWakefulness=' + (issue === 'asleep' ? 'Dozing' : 'Awake');
        if (command.join(' ') === 'dumpsys input') return 'Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, ' + (issue === 'display' || rotated ? 101 : 100) + ', 200], isActive=[1]';
        throw Error('Unexpected command');
      } };
    const store = { allocate() { assert.fail('A guard failure must precede allocation and recorder launch'); } };
    await assert.rejects(() => captureShortClip(adb, { getElements: () => { rotated = issue === 'rotate-during-ui'; return [{ password: issue === 'password' }]; } }, 'synthetic-device', store, 1,
      { expectedPackage: args.expectedPackage, expectedDisplay: args.expectedDisplay }, () => assert.fail('No capture should start'), f.security),
    /SCREEN_ASLEEP|LOCKED_OR_UNKNOWN|CLIP_FOREGROUND_CHANGED|CLIP_DISPLAY_CHANGED|CLIP_PASSWORD_INPUT_VISIBLE/);
    assert(commands.every(command => command[0] === 'dumpsys'));
  }
});

const mediaAvailable = process.platform === 'linux' && [process.env.PHONE_FFMPEG || 'ffmpeg', process.env.PHONE_FFPROBE || 'ffprobe', 'python3'].every(command => {
  try { execFileSync(command, [command === 'python3' ? '--version' : '-version'], { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
});
test('Linux capture publishes real decodable media, taps once, and preserves completed media when journal acknowledgement fails',
  { skip: !mediaAvailable ? 'Linux capture fixture requires Python and FFmpeg' : false, timeout: 20000 }, async () => {
    const directory = fresh(), media = path.join(directory, 'fixture.mkv'), recorder = path.join(directory, 'recorder.py');
    execFileSync(process.env.PHONE_FFMPEG || 'ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5',
      '-frames:v', '5', '-c:v', 'ffv1', '-f', 'matroska', '-y', media], { stdio: 'pipe', timeout: 10000 });
    fs.writeFileSync(recorder, '#!/usr/bin/env python3\nimport shutil, signal, sys, time\n' +
      'target = next(arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--record="))\n' +
      'shutil.copyfile(' + JSON.stringify(media) + ', target)\n' +
      'def stop(*_):\n    print("Recording complete to matroska file: fixture", flush=True)\n    sys.exit(0)\n' +
      'signal.signal(signal.SIGINT, stop)\nprint("Recording started to matroska file: fixture", flush=True)\n' +
      'while True: time.sleep(0.02)\n', { mode: 0o700 });
    const fixture = fixtureOwner(directory, { shortClips: { ...config, recorderPath: recorder } });
    const security = new OwnerSecurity(fixture.file), store = new ClipStore(security.directory, { keepsakesEnabled: true }); let taps = 0;
    const adb = { getFocusedPackage: () => 'org.example.game', shell(_device, ...command) {
      if (command.join(' ') === 'dumpsys window policy') return 'showing=false';
      if (command.join(' ') === 'dumpsys power') return 'mWakefulness=Awake';
      if (command.join(' ') === 'dumpsys input') return 'Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 100, 200], isActive=[1]';
      if (command[0] === 'am' && command[1] === 'instrument') { taps++; return 'phone_result_b64=' + Buffer.from(JSON.stringify({ ok: true, pointerReleased: true })).toString('base64'); }
      throw Error('Unexpected phone operation');
    } };
    const input = { expectedPackage: args.expectedPackage, expectedDisplay: args.expectedDisplay, durationMs: 1000 };
    const states = [];
    const complete = await withDeadline(25000, () => captureShortClip(adb, { getElements: () => [] }, 'synthetic-device', store, 1,
      { ...input, tap: { x: 1, y: 2 } }, state => states.push(state), security));
    assert.equal(taps, 1); assert.deepEqual(states, ['unconfirmed', 'acknowledged']); assert.equal(complete.status, 'complete');
    assert.equal(store.frame(complete.id, 0).width, 160);
    let failure;
    try {
      await withDeadline(25000, () => captureShortClip(adb, { getElements: () => [] }, 'synthetic-device', store, 2, input,
        state => { if (state === 'acknowledged') throw Error('Synthetic journal ENOSPC'); }, security));
    } catch (error) { failure = error; }
    assert(failure instanceof ClipCaptureError); assert.equal(failure.capture.mediaStatus, 'complete');
    assert.equal(failure.capture.failureReceiptSaved, false); assert.equal(failure.capture.tapState, 'not_requested');
    assert.equal(store.open(failure.capture.clipId).status, 'complete');
    assert.equal(taps, 1, 'No journal failure can cause replay or a new tap');
    store.keep(complete.id, 'Synthetic exported clip');
    fixture.config.shortClips.enabled = false;
    fs.writeFileSync(fixture.file, JSON.stringify(fixture.config));
    const exported = JSON.parse(execFileSync(process.execPath, ['scripts/export-clip-keepsakes.mjs', path.join(directory, 'export')],
      { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10000, env: { ...process.env, PHONE_SECURITY_FILE: fixture.file } }));
    assert.equal(exported.verified, true); assert.equal(exported.count, 1);
    assert(fs.existsSync(path.join(directory, 'export', 'manifest.json')));
  });
