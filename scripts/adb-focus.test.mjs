import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFocusIdentity, parseWindowOwner, uniqueOwnerPackage } from '../dist/focus-identity.js';
import { focusAdb, focusProto, windowDetails, identity, bytes, scalar, pack } from './fixtures/focus.mjs';

const focused = options => focusAdb(options).adb.getFocusedPackage('synthetic-device');

test('focused package is bound to WMS owner UID, unique installed package and two matching snapshots', () => {
  const { adb, commands } = focusAdb();
  assert.equal(adb.getFocusedPackage('synthetic-device'), 'org.example.game');
  assert.deepEqual(commands, [
    ['exec-out', 'dumpsys', 'window', '--proto'], ['dumpsys', 'window', '1234'],
    ['cmd', 'package', 'list', 'packages', '--user', '0', '--uid', '10123'],
    ['exec-out', 'dumpsys', 'window', '--proto'],
  ]);
  assert.equal(focused({ current: { title: 'A custom game title' } }), 'org.example.game');
  assert.equal(focused({ current: { userId: 2 }, owner: { uid: 210123 } }), 'org.example.game');
});

test('an allowed-looking title or package attribute cannot establish another UID owner', () => {
  assert.equal(focused({ owner: { packageName: 'org.other.app' } }), 'unknown');
  assert.equal(focused({ packages: 'package:org.other.app uid:10123\n' }), 'unknown');
  assert.equal(focused({ current: { title: 'org.example.game.extra/.Main' }, owner: { packageName: 'org.example.game.extra' } }), 'org.example.game.extra');
});

test('title syntax, injected dump lines and saved ANR text never become focus metadata', () => {
  for (const title of ['game\n    mOwnerUid=10123', 'game\rtitle', 'game\0title', 'game\u2028title']) {
    const { adb, commands } = focusAdb({ current: { title } });
    assert.equal(adb.getFocusedPackage('synthetic-device'), 'unknown'); assert.equal(commands.length, 1);
  }
  const stale = '  mCurrentFocus=Window{1234 u0 org.example.game/.MainActivity}\n';
  for (const options of [
    { details: 'WINDOW MANAGER LAST ANR\n' + windowDetails() }, { proto: Buffer.from(stale) },
    { proto: bytes(4, stale) },
    { details: windowDetails() + '    mOwnerUid=10123 showForAllUsers=false package=org.example.game appop=NONE\n' },
  ]) assert.equal(focused(options), 'unknown');
});

test('duplicate, conflicting or nondefault display and window identities fail closed', () => {
  for (const options of [
    { extraFocus: true }, { extraDisplay: true }, { displayId: 1 },
    { displayFocus: identity({ hash: 0x4567 }) }, { displayFocus: identity({ title: 'another' }) },
    { displayFocus: identity({ userId: 1 }) },
    { proto: pack(focusProto(), scalar(9, 0), scalar(9, 0)) },
    { owner: { displayId: 1 } }, { details: windowDetails() + windowDetails() },
  ]) assert.equal(focused(options), 'unknown');
});

test('missing, malformed and nonunique owner/package evidence remains unknown', () => {
  for (const options of [
    { proto: Buffer.alloc(0) }, { proto: bytes(3, identity()) }, { current: { hash: 0 } },
    { current: { title: '' } }, { proto: focusProto().subarray(0, 8) },
    { details: '' }, { details: windowDetails().replace('mOwnerUid=10123', 'owner=10123') },
    { owner: { packageName: 'bad-package' } }, { owner: { hash: 0x4567 } }, { owner: { uid: 110123 } },
    { packages: '' }, { packages: 'package:org.example.game uid:10124\n' },
    { packages: 'package:org.example.game uid:10123\npackage:org.shared.app uid:10123\n' },
  ]) assert.equal(focused(options), 'unknown');
});

test('a focused system overlay is resolved to its own package; shared UID ambiguity is rejected', () => {
  const overlay = { current: { title: 'com.android.permissioncontroller/.Dialog' }, owner: { uid: 10145, packageName: 'com.android.permissioncontroller' } };
  assert.equal(focused(overlay), 'com.android.permissioncontroller');
  assert.equal(focused({ ...overlay, packages: 'package:com.android.permissioncontroller uid:10145\npackage:org.shared.app uid:10145\n' }), 'unknown');
});

test('focus drift and query failures cannot reuse prior focus or a resumed app', () => {
  for (const next of [focusProto({ current: { hash: 0x4567 } }), focusProto({ extraDisplay: true }), Buffer.alloc(0)])
    assert.equal(focused({ snapshots: [focusProto(), next] }), 'unknown');
  for (const fail of ['proto', 'owner', 'packages']) assert.throws(() => focused({ fail }), /Synthetic .* query failure/);
});

test('bounded protobuf reader rejects truncation, duplicate identity fields and invalid wire values', () => {
  const valid = focusProto();
  for (let length = 0; length < valid.length; length++) assert.equal(parseFocusIdentity(valid.subarray(0, length)), null);
  for (const malformed of [Buffer.alloc(4 * 1024 * 1024 + 1), Buffer.from([15]), Buffer.alloc(12, 255),
    pack(valid, bytes(9, '0')), focusProto({ rootFocus: pack(identity(), scalar(1, 0x1234)) })])
    assert.equal(parseFocusIdentity(malformed), null);
  assert.equal(parseWindowOwner('x'.repeat(256 * 1024 + 1), parseFocusIdentity(valid)), null);
  assert.equal(uniqueOwnerPackage('x'.repeat(32769), { uid: 10123, packageName: 'org.example.game' }), false);
});
