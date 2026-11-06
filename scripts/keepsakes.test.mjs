import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { KeepsakeStore } from '../dist/keepsakes.js';
import { privateDirectory, writePrivate } from '../dist/private-files.js';

fs.mkdirSync('.runtime', { recursive: true });
const fresh = () => privateDirectory(fs.mkdtempSync(path.resolve('.runtime/keepsakes-')));
const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const origin = eventId => ({ eventId, tool: 'android_take_screenshot', capturedAt: '2026-01-02T03:04:05.000Z', capturedAtSource: 'capture-finished' });
const unlimited = { maxBytes: null, maxCount: null };

test('keepsakes are immutable, deduplicated, privately stored and reopen independently with verified provenance', () => {
  const root = fresh(), store = new KeepsakeStore(root, unlimited);
  const first = store.save(origin(1), png, { title: 'A small step', note: 'Synthetic evidence' });
  assert(first.created); assert.equal(first.record.sha256, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(first.record.origin, origin(1));
  const duplicate = store.save(origin(1), png, { title: 'Changed title', note: 'Changed note' });
  assert(!duplicate.created); assert.deepEqual(duplicate.record, first.record); assert.equal(duplicate.status.count, 1);
  const reopened = new KeepsakeStore(root, unlimited).open(first.record.id);
  assert.deepEqual(reopened.png, png); assert.deepEqual(reopened.record, first.record);
  const second = store.save(origin(2), png, { title: 'Another event' });
  const page = store.list({ limit: 1 }); assert.equal(page.records.length, 1); assert(page.nextBefore);
  const next = store.list({ limit: 1, before: page.nextBefore }); assert.equal(next.records.length, 1); assert.equal(next.nextBefore, null);
  assert.notEqual(next.records[0].id, page.records[0].id); assert.equal(second.status.maxBytes, null); assert.equal(second.status.migrationRecommended, false);
  const imageFile = path.join(store.directory, first.record.id, 'image.png');
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1; fs.writeFileSync(imageFile, changed);
  assert.throws(() => store.open(first.record.id), /CHECKSUM_MISMATCH/);
});

test('keepsake byte and count budgets include metadata, warn near capacity, preserve old entries and allow dedup at cap', () => {
  const root = fresh(), store = new KeepsakeStore(root, unlimited);
  const saved = store.save(origin(1), png, { title: 'Preserved' });
  assert(saved.status.usedBytes > png.length);
  const bounded = new KeepsakeStore(root, { maxBytes: saved.status.usedBytes, maxCount: 1 });
  assert.equal(bounded.status().migrationRecommended, true);
  assert.match(bounded.status().warning, /80%/);
  assert(!bounded.save(origin(1), png, { title: 'No duplicate bytes' }).created);
  assert.throws(() => bounded.save(origin(2), png, { title: 'Rejected' }), error => error.code === 'KEEPSAKE_CAPACITY_REACHED' && error.storageStatus.count === 1);
  assert.deepEqual(bounded.open(saved.record.id).png, png); assert.equal(bounded.status().count, 1);
  const byteOnly = new KeepsakeStore(root, { maxBytes: 1, maxCount: null });
  assert.throws(() => byteOnly.save(origin(2), png, { title: 'Rejected by bytes' }), /CAPACITY_REACHED/);
});

test('keepsake publication failure leaves no committed partial record and releases only its own staging files and lock', t => {
  const store = new KeepsakeStore(fresh(), unlimited);
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (source, target) => {
    if (source.includes('.pending-')) throw Error('Synthetic publication failure');
    return rename(source, target);
  });
  assert.throws(() => store.save(origin(1), png, { title: 'Interrupted' }), /Synthetic publication failure/);
  mocked.mock.restore();
  assert.deepEqual(fs.readdirSync(store.directory), []);
  writePrivate(path.join(store.directory, '.write.lock'), 'synthetic-other-writer');
  assert.throws(() => store.save(origin(1), png, { title: 'Busy' }), /STORAGE_BUSY/);
  assert.equal(fs.readFileSync(path.join(store.directory, '.write.lock'), 'utf8'), 'synthetic-other-writer');
  fs.unlinkSync(path.join(store.directory, '.write.lock'));
  assert(store.save(origin(1), png, { title: 'Recovered' }).created);
});

test('keepsake paths, hard links, metadata and staging residue cannot bypass bounds', () => {
  const root = fresh(), store = new KeepsakeStore(root, unlimited);
  for (const id of ['../token.key', '/tmp/outside', 'A'.repeat(64), '']) assert.throws(() => store.open(id), /INVALID_ID/);
  assert.throws(() => store.list({ limit: 31 }), /INVALID_CURSOR/);
  assert.throws(() => store.list({ before: '0'.repeat(64) }), /INVALID_CURSOR/);
  for (const labels of [{ title: ' ' }, { title: 'x'.repeat(161) }, { title: 'x', note: 'x'.repeat(4097) }])
    assert.throws(() => store.save(origin(1), png, labels), /INVALID_METADATA/);
  assert.throws(() => store.save({ ...origin(1), eventId: -1 }, png, { title: 'Invalid' }), /INVALID_METADATA/);
  assert.throws(() => store.save(origin(1), Buffer.alloc(17 * 1024 * 1024), { title: 'Too large' }), /IMAGE_LIMIT/);
  const saved = store.save(origin(1), png, { title: 'Linked file test' });
  const original = path.join(store.directory, saved.record.id, 'image.png'), link = path.join(root, 'other.png');
  fs.linkSync(original, link); assert.throws(() => store.open(saved.record.id), /INVALID_STORAGE/); fs.unlinkSync(link);
  const pending = privateDirectory(path.join(store.directory, '.pending-00000000-0000-0000-0000-000000000001'));
  writePrivate(path.join(pending, 'image.png'), png);
  assert.equal(store.status().pendingEntries, 1); assert.match(store.status().warning, /Incomplete/);
  const countBound = new KeepsakeStore(root, { maxBytes: null, maxCount: 2 });
  assert.throws(() => countBound.save(origin(2), png, { title: 'Pending reserves quota' }), /CAPACITY_REACHED/);
  assert(fs.existsSync(pending));
});

test('keepsake directory links are rejected without following them', t => {
  const root = fresh(), outside = fresh(), store = new KeepsakeStore(root, unlimited);
  const link = path.join(store.directory, 'a'.repeat(64));
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS account cannot create a link fixture'); throw error; }
  assert.throws(() => store.status(), /links/);
  assert.throws(() => store.open('a'.repeat(64)), /links/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('owner export uses a new private destination, verifies bytes, preserves source, and leaves no success manifest on corruption', () => {
  const root = fresh(), store = new KeepsakeStore(root, unlimited);
  const saved = store.save(origin(1), png, { title: 'Exported memory' });
  const destination = path.join(root, 'export');
  assert.throws(() => store.exportTo(path.join(store.directory, 'nested')), /INSIDE_SOURCE/);
  const exported = store.exportTo(destination);
  assert.equal(exported.verified, true); assert.equal(exported.sourceRetained, true); assert.equal(exported.count, 1);
  assert.deepEqual(fs.readFileSync(path.join(destination, saved.record.id, 'image.png')), png);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'))).records, [saved.record]);
  assert.equal(store.status().count, 1); assert.throws(() => store.exportTo(destination), /DESTINATION_EXISTS/);
  fs.writeFileSync(path.join(store.directory, saved.record.id, 'image.png'), Buffer.alloc(png.length));
  const failed = path.join(root, 'failed-export');
  assert.throws(() => store.exportTo(failed), /CHECKSUM_MISMATCH/);
  assert(!fs.existsSync(path.join(failed, 'manifest.json'))); assert.equal(store.status().count, 1);
});
