import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureOwner } from './fixtures/owner.mjs';
import { focusAdb, focusProto, windowDetails } from './fixtures/focus.mjs';
import { OwnerSecurity } from '../dist/security.js';
import { Executor } from '../dist/executor.js';
import { captureShortClip } from '../dist/clip-capture.js';

fs.mkdirSync('.runtime', { recursive: true });
const fixture = () => {
  const owner = fixtureOwner(fs.mkdtempSync(path.resolve('.runtime/focus-guards-')), {
    allowedApps: ['org.example.game', 'org.example.othergame'],
    shortClips: { enabled: true, allowedApps: ['org.example.game'], acceptsTransientScreenContent: true, recorderPath: process.execPath },
  });
  return { ...owner, security: new OwnerSecurity(owner.file) };
};
const blocked = [
  { owner: { packageName: 'org.other.app' } },
  { packages: 'package:org.other.app uid:10123\n' },
  { current: { title: 'game\n  mCurrentFocus=Window{1234 u0 org.example.game/.Main}' } },
  { details: 'WINDOW MANAGER LAST ANR\n' + windowDetails() },
  { extraFocus: true }, { extraDisplay: true }, { displayId: 1 }, { proto: Buffer.alloc(0) },
  { fail: 'owner' },
  { current: { title: 'com.android.permissioncontroller/.Dialog' }, owner: { uid: 10145, packageName: 'com.android.permissioncontroller' } },
  { current: { title: 'org.example.game.extra/.Main' }, owner: { packageName: 'org.example.game.extra' } },
  { current: { title: 'org.example.othergame/.Main' }, owner: { packageName: 'org.example.othergame' } },
];
const catalog = [{ name: 'android_type_text', inputSchema: { type: 'object', properties: {
  text: { type: 'string' }, requestId: { type: 'string' }, expectedPackage: { type: 'string' },
  expectedUrl: { type: 'string' }, approval: { type: 'object' },
}, required: ['text', 'requestId', 'expectedPackage'], additionalProperties: false } }];
const jsonItems = result => result.content.filter(item => item.type === 'text').flatMap(item => {
  try { return [JSON.parse(item.text)]; } catch { return []; }
});

test('Executor uses real focus ownership resolution before input/UI and preserves a normal allowed input path', async () => {
  const owner = fixture(); let inputs = 0, uiReads = 0;
  const executor = new Executor(owner.security, 'synthetic-device', { callTool() {
    inputs++; return { content: [{ type: 'text', text: 'synthetic input acknowledged' }] };
  } }, catalog);
  executor.ui = { getElements() { uiReads++; return []; } };
  const call = async (options, index) => {
    executor.adb = focusAdb(options).adb;
    const request = owner.authorize({ name: 'android_type_text', arguments: {
      text: 'synthetic fixture', expectedPackage: 'org.example.game', requestId: `focus-guard-${index}`,
    } });
    return executor.call(request.name, request.arguments);
  };
  try {
    for (const [index, options] of blocked.entries()) {
      const result = await call(options, index);
      assert.equal(result.isError, true); assert.equal(inputs, 0); assert.equal(uiReads, 0);
      assert.equal(jsonItems(result).find(item => item.phoneReceipt).phoneReceipt.execution, 'not_started');
    }
    const success = await call({}, 'allowed');
    assert.equal(success.isError, undefined); assert.equal(inputs, 1); assert.equal(uiReads, 1);
    assert.equal(jsonItems(success).find(item => item.phoneReceipt).phoneReceipt.execution, 'acknowledged');
    const drift = await call({ snapshots: [focusProto(), focusProto(), focusProto({ extraDisplay: true })] }, 'post-drift');
    assert.equal(drift.isError, true); assert.equal(inputs, 2);
    assert.equal(jsonItems(drift).find(item => item.phoneReceipt).phoneReceipt.execution, 'acknowledged');
    assert.match(JSON.stringify(drift), /POSTCONDITION_FAILED/);
  } finally { await executor.close(); }
});

test('Linux clip guard uses real focus resolution and reaches allocation only for the exact allowed owner',
  { skip: process.platform !== 'linux' }, async () => {
    const owner = fixture(); let allocations = 0, uiReads = 0;
    const allocationReached = new Error('Synthetic allocation boundary reached; no recorder started');
    const store = { allocate() { allocations++; throw allocationReached; } };
    const ui = { getElements() { uiReads++; return []; } };
    const run = options => captureShortClip(focusAdb(options).adb, ui, 'synthetic-device', store, 1,
      { expectedPackage: 'org.example.game', expectedDisplay: { width: 100, height: 200 }, durationMs: 1000 },
      () => assert.fail('No recorder or input in this guard test'), owner.security);
    for (const options of blocked) {
      await assert.rejects(() => run(options), error => error !== allocationReached);
      assert.equal(allocations, 0); assert.equal(uiReads, 0);
    }
    await assert.rejects(() => run({}), error => error === allocationReached);
    assert.equal(allocations, 1); assert.equal(uiReads, 1);
  });
